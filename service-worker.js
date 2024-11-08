self.addEventListener('online', async () => {
    console.log('Network restored - restarting checks');
    const cache = await caches.open(AUTH_CACHE_NAME);
    const tokenResponse = await cache.match('auth-token');
    
    if (tokenResponse) {
        const token = await tokenResponse.text();
        await checkNewOrders(token);
    } else {
        await startPeriodicCheck();
    }
});

self.addEventListener('offline', () => {
    console.log('Network connection lost');
    networkRetryTimeout = setTimeout(() => {
        startPeriodicCheck();
    }, 5000);
});

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
const FETCH_TIMEOUT = 30000;
const MAX_RETRIES = 5;
const MIN_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;

let credentials = null;
let securityKey = null;
let isChecking = false;
let wakeLock = null;
let networkRetryTimeout;

function ensureNetworkRecovery() {
    setInterval(() => {
        if (navigator.onLine) {
            startPeriodicCheck();
        }
    }, 30000);
}

class WakeLockManager {
    constructor() {
        this.wakeLock = null;
        this.isActive = false;
        this.startWakeLockLoop();
    }

    startWakeLockLoop() {
        setInterval(() => {
            this.acquire();
        }, 20000);
    }

    async acquire() {
        if (!this.isActive && 'wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.isActive = true;
                this.wakeLock.addEventListener('release', () => {
                    this.isActive = false;
                    this.acquire();
                });
            } catch (err) {
                console.log('Wake Lock error:', err);
                setTimeout(() => this.acquire(), 5000);
            }
        }
    }
}

function startKeepAlive() {
    setInterval(() => {
        fetch('/api/ping', {
            method: 'POST',
            keepalive: true
        }).catch(err => console.log('Keep alive ping failed:', err));
    }, 20000);
}

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
        if (!navigator.onLine) return;
        
        try {
            const cache = await caches.open(AUTH_CACHE_NAME);
            const tokenResponse = await cache.match('auth-token');
            
            if (!tokenResponse) {
                await login();
                return;
            }

            const token = await tokenResponse.text();
            const response = await fetch(`${API_BASE_URL}/health`, {
                method: 'GET',
                headers: {
                    'Authorization': token,
                    'Cache-Control': 'no-cache'
                },
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) {
                await startPeriodicCheck();
            }
        } catch (error) {
            await startPeriodicCheck();
        }
    }, PING_INTERVAL);
}

function ensurePersistentOperation() {
    const wakeLockManager = new WakeLockManager();
    wakeLockManager.acquire();
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

async function verifyCredentials() {
    const cache = await caches.open(AUTH_CACHE_NAME);
    const tokenResponse = await cache.match('auth-token');
    
    if (!tokenResponse) {
        console.log('Token missing, attempting relogin');
        await login();
        return;
    }

    try {
        const token = await tokenResponse.text();
        const response = await fetch(`${API_BASE_URL}/api/Authorization/Verify`, {
            method: 'GET',
            headers: {
                'Authorization': token,
                'SecurityKey': securityKey
            }
        });
        
        if (!response.ok) {
            console.log('Token invalid, refreshing login');
            await login();
        }
    } catch (error) {
        console.log('Verification failed, attempting relogin');
        await login();
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
        const response = await fetch(`${API_BASE_URL}/api/Orders/GetOrders`, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'authorizationcode': token,
                'content-type': 'application/json',
                'referer': 'https://portal.ghazaresan.com/',
                'securitykey': securityKey,
            },
            body: JSON.stringify({}),
            // Add timeout
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const responseData = await response.json();
        return responseData;
    } catch (error) {
        console.log('Check orders failed:', error);
        // Force token refresh on error
        await login();
        throw error;
    } finally {
        isChecking = false;
    }
}

async function startPeriodicCheck() {
    let retryCount = 0;
    const maxRetries = 5;
    
    const check = async () => {
        try {
            const token = await login();
            await checkNewOrders(token);
            retryCount = 0;
        } catch (error) {
            retryCount++;
            const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
            console.log(`Retry attempt ${retryCount} in ${delay}ms`);
            
            if (retryCount < maxRetries) {
                setTimeout(check, delay);
            } else {
                console.log('Max retries reached, restarting service worker');
                self.registration.update();
            }
            return;
        }
        setTimeout(check, ORDER_CHECK_INTERVAL);
    };
    
    check();
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
        startKeepAlive();
        ensureNetworkRecovery();
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
    } else if (event.data.type === 'FORCE_CHECK') {
        startPeriodicCheck();
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

setInterval(verifyCredentials, 60000);
