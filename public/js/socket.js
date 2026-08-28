// Socket.IO connection manager
// Polling-only: WebSocket upgrades do not reliably carry cached Basic Auth
// headers across browsers (notably iOS Safari), so the authenticated
// long-polling transport is the only transport that keeps the auth boundary.
window.socket = io({ transports: ['polling'] });

const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');

socket.on('connect', () => {
  statusDot.classList.add('connected');
  statusText.textContent = 'Connected';
});

socket.on('disconnect', () => {
  statusDot.classList.remove('connected');
  statusText.textContent = 'Disconnected';
});

socket.on('connect_error', () => {
  statusDot.classList.remove('connected');
  statusText.textContent = 'Error';
});
