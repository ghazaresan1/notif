let interval;

self.addEventListener('message', (e) => {
    if (e.data === 'start') {
        interval = setInterval(() => {
            fetch('/api/ping', {
                method: 'POST',
                keepalive: true
            });
        }, 20000);
    }
});
