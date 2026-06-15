// Socket.IO connection manager
// CRITICAL: window.socket must be created synchronously so other scripts
// (processes.js, alerts.js, dashboard.js) can register listeners immediately.
// Do NOT make window.socket depend on an awaited fetch.

let _authToken = null;

function getBasicAuthToken() {
  return _authToken;
}

// Create socket synchronously — other scripts depend on this
window.socket = io({ autoConnect: false });

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

socket.on('connect_error', (err) => {
  statusDot.classList.remove('connected');
  statusText.textContent = 'Auth error — refresh page';
});

// Fetch auth token, then connect
async function initSocket() {
  try {
    const res = await fetch('/api/session');
    if (res.ok) {
      const data = await res.json();
      _authToken = data.token;
      socket.auth = { token: _authToken };
    }
  } catch (e) {
    // Will connect without auth (server will reject)
  }

  socket.connect();
}

initSocket();
