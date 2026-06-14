// Socket.IO connection manager
window.socket = io();

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
