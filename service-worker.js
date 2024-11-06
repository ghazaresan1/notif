const KEEP_ALIVE_PING = 'keep-alive';
const AUTH_CACHE_NAME = 'auth-cache';
const API_BASE_URL = 'https://app.ghazaresan.com';
const WAKE_INTERVAL = 25000;
const BACKUP_INTERVAL = 20000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 5000;
const ORDER_CHECK_INTERVAL = 20000;
const HEARTBEAT_INTERVAL = 30000;
const PING_INTERVAL = 15000;
const WATCHDOG_INTERVAL = 45000;
const HEALTH_CHECK_INTERVAL = 35000;

let credentials = null;
let securityKey = null;
let isChecking = false;

function startWatchdog() {
    setInterval(async () => {
        const cache = await caches.open(AUTH_CACHE_NAME);
        const lastPing = await cache.match('last-ping');
        if (lastPing) {
            const pingTime = parseInt(await lastPing.text());
            if (Date.now() - pingTime > WATCHDOG_INTERVAL) {
                await startPeriodicCheck();
            }
        }
        await cache.put('last-ping', new Response(Date.now().toString()));
    }, WATCHDOG_INTERVAL);
}

function enhancedKeepAlive() {
    setInterval(async () => {
        const cache = await caches.open(AUTH_CACHE_NAME);
        await cache.put('keepalive', new Response(Date.now().toString()));
        self.registration.active?.postMessage({ type: 'HEARTBEAT' });
        
        try {
            const response = await fetch(`${API_BASE_URL}/health`, {
                method: 'GET',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!response.ok) {
                await startPeriodicCheck();
            }
        } catch (error) {
            console.log('Health check failed, restarting services...');
            await startPeriodicCheck();
        }
    }, PING_INTERVAL);
}
function ensurePersistentOperation() {
    if ('wakeLock' in navigator) {
        setInterval(async () => {
            try {
                const wakeLock = await navigator.wakeLock.request('screen');
                setTimeout(() => wakeLock.release(), 500);
            } catch (err) {
                console.log('Wake lock request failed');
            }
        }, HEALTH_CHECK_INTERVAL);
    }
}

async function retryWithBackoff(fn, retries = MAX_RETRY_ATTEMPTS) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * Math.pow(2, i)));
        }
    }
}

function verifyServiceWorkerActive() {
    setInterval(async () => {
        const cache = await caches.open(AUTH_CACHE_NAME);
        const tokenResponse = await cache.match('auth-token');
        
        if (!tokenResponse) {
            const token = await login();
            startPeriodicCheck();
        }
        
        self.registration.active?.postMessage({ type: 'HEARTBEAT' });
        console.log('Service Worker heartbeat sent');
    }, HEARTBEAT_INTERVAL);
}

function createWakeLoop() {
    setInterval(async () => {
        const allClients = await clients.matchAll();
        if (allClients.length === 0) {
            self.registration.update();
        }
    }, WAKE_INTERVAL);
}

function createBackupLoop() {
    setInterval(async () => {
        try {
            const cache = await caches.open(AUTH_CACHE_NAME);
            const tokenResponse = await cache.match('auth-token');
            if (tokenResponse) {
                const token = await tokenResponse.text();
                await fetch(`${API_BASE_URL}/api/Orders/GetOrders`, {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'authorizationcode': token,
                        'content-type': 'application/json',
                        'securitykey': securityKey,
                    },
                    body: JSON.stringify({})
                });
            }
        } catch (error) {
            console.log('Backup loop check failed, continuing...');
        }
    }, BACKUP_INTERVAL);
}

async function login() {
    if (!credentials?.username || !credentials?.password) {
        throw new Error('Invalid credentials format');
    }

    return retryWithBackoff(async () => {
        const response = await fetch(`${API_BASE_URL}/api/Authorization/Authenticate`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'SecurityKey': securityKey,
                'Referer': 'https://portal.ghazaresan.com/'
            },
            body: JSON.stringify({
                UserName: credentials.username,
                Password: credentials.password
            })
        });

        if (!response.ok) {
            throw new Error(`Login failed with status: ${response.status}`);
        }

        const data = await response.json();
        
        if (!data.Token) {
            throw new Error('No token received in response');
        }

        const cache = await caches.open(AUTH_CACHE_NAME);
        await Promise.all([
            cache.put('auth-token', new Response(data.Token)),
            cache.put('restaurant-info', new Response(JSON.stringify({
                name: data.RestaurantName,
                canEditMenu: data.CanEditMenu
            })))
        ]);

        return data.Token;
    });
}

async function showNewOrderNotification(orderCount) {
    await self.registration.showNotification('سفارش جدید', {
        body: 'یک سفارش جدید در انتظار تایید دارید',
        icon: '/notif/icon.png',
        badge: '/notif/badge.png',
        vibrate: [200, 100, 200],
        tag: 'new-order',
        renotify: true,
        requireInteraction: true,
        silent: false
    });
}

async function checkNewOrders(token) {
    if (isChecking) return;
    isChecking = true;
    
    try {
        return await retryWithBackoff(async () => {
            const response = await fetch(`${API_BASE_URL}/api/Orders/GetOrders`, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'authorizationcode': token,
                    'content-type': 'application/json',
                    'referer': 'https://portal.ghazaresan.com/',
                    'securitykey': securityKey,
                },
                body: JSON.stringify({})
            });

            const responseData = await response.json();
            console.log('Order check completed successfully');
            
            if (Array.isArray(responseData)) {
                const newOrders = responseData.filter(order => order.Status === 0);
                if (newOrders.length > 0) {
                    await showNewOrderNotification(newOrders.length);
                }
            }
            
            return responseData;
        });
    } finally {
        isChecking = false;
    }
}

async function startPeriodicCheck() {
    try {
        const token = await login();
        console.log('Periodic check started');
        
        const checkInterval = 20000;
        const periodicCheck = async () => {
            try {
                await checkNewOrders(token);
            } catch (error) {
                console.log('Check failed, retrying with new token...');
                const newToken = await login();
                await checkNewOrders(newToken);
            }
            setTimeout(periodicCheck, checkInterval);
        };
        
        periodicCheck();
        verifyServiceWorkerActive();
    } catch (error) {
        console.log('Service Worker check failed, restarting...');
        setTimeout(startPeriodicCheck, 5000);
    }
}

self.addEventListener('install', (event) => {
    console.log('Service Worker installing.');
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        await clients.claim();
        createWakeLoop();
        createBackupLoop();
        enhancedKeepAlive();
        startWatchdog();
        ensurePersistentOperation();
    })());
});

self.addEventListener('sync', (event) => {
    if (event.tag === 'check-orders') {
        event.waitUntil(checkNewOrders());
    }
});

self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'background-sync') {
        event.waitUntil(checkNewOrders());
    }
});

self.addEventListener('message', event => {
    if (event.data.type === 'CREDENTIALS') {
        credentials = {
            username: event.data.username,
            password: event.data.password
        };
        securityKey = event.data.securityKey;
        startPeriodicCheck();
    } else if (event.data.type === KEEP_ALIVE_PING) {
        console.log('Keep-alive ping received');
    }
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('https://portal.ghazaresan.com/orderlist')
    );
});

setInterval(() => {
    self.registration.update();
}, 10 * 60 * 1000);
