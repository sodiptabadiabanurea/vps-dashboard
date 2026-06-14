// Socket.IO connection manager
// Fetch auth token from server and pass to Socket.IO

let _authToken = null;

function getBasicAuthToken() {
  return _authToken;
}

// Fetch token on page load, then connect Socket.IO
async function initSocket() {
  try {
    const res = await fetch('/api/session');
    if (res.ok) {
      const data = await res.json();
      _authToken = data.token;
    }
  } catch (e) {
    // Will connect without auth (server will reject)
  }

  const authOpts = {};
  if (_authToken) authOpts.auth = { token: _authToken };

  window.socket = io(authOpts);

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
}

initSocket();
