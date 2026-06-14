// File Manager
(function() {
  let currentPath = '';
  let editingFile = '';

  async function fmLoad(dir) {
    try {
      currentPath = dir || '';
      const res = await fetch(`/api/files?path=${encodeURIComponent(currentPath)}`);
      const data = await res.json();
      currentPath = data.path;

      // Breadcrumb
      const parts = currentPath.split('/').filter(Boolean);
      let breadcrumb = '<a onclick="window.fmLoad(\'\')">~</a>';
      let builtPath = '';
      for (const part of parts) {
        builtPath += '/' + part;
        const p = builtPath;
        breadcrumb += ` / <a onclick="window.fmLoad('${p}')">${part}</a>`;
      }
      document.getElementById('fmBreadcrumb').innerHTML = breadcrumb;

      // File list
      const tbody = document.getElementById('fmFiles');
      tbody.innerHTML = data.items.map(item => {
        const icon = item.type === 'directory' ? '📁' : '📄';
        const nameAction = item.type === 'directory'
          ? `<a onclick="window.fmLoad('${item.path}')" style="color:var(--accent);cursor:pointer">${item.name}</a>`
          : `<a onclick="window.fmEdit('${item.path}')" style="color:var(--text-primary);cursor:pointer">${item.name}</a>`;
        const size = item.type === 'directory' ? '-' : formatSize(item.size);
        const modified = item.modified ? new Date(item.modified).toLocaleString('id-ID') : '-';
        return `
          <tr>
            <td class="fm-icon">${icon}</td>
            <td>${nameAction}</td>
            <td class="val" style="font-size:12px">${size}</td>
            <td class="val" style="font-size:11px;color:var(--text-muted)">${modified}</td>
            <td class="val" style="font-size:11px;color:var(--text-muted)">${item.permissions || '-'}</td>
            <td>
              <div class="fm-actions">
                ${item.type === 'file' ? `<button class="proc-btn" onclick="window.fmDownload('${item.path}')">↓</button>` : ''}
                <button class="proc-btn danger" onclick="window.fmDelete('${item.path}','${item.name}')">✕</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('File manager error:', err);
    }
  }

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  async function fmEdit(filePath) {
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      editingFile = filePath;
      document.getElementById('fmEditorPath').textContent = filePath;
      document.getElementById('fmEditorContent').value = data.content;
      document.getElementById('fmEditorCard').style.display = 'block';
    } catch (err) {
      window.showToast(`Error: ${err.message}`, true);
    }
  }

  async function fmSave() {
    try {
      const content = document.getElementById('fmEditorContent').value;
      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editingFile, content }),
      });
      const data = await res.json();
      if (data.ok) {
        window.showToast('File saved');
        document.getElementById('fmEditorCard').style.display = 'none';
        fmLoad(currentPath);
      } else {
        window.showToast(`Error: ${data.error}`, true);
      }
    } catch (err) {
      window.showToast(`Error: ${err.message}`, true);
    }
  }

  function fmUp() {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    fmLoad('/' + parts.join('/'));
  }

  function fmRefresh() { fmLoad(currentPath); }

  function fmDownload(filePath) {
    window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`);
  }

  function fmDelete(filePath, name) {
    window.showConfirm(
      `Delete ${name}?`,
      'This action cannot be undone.',
      async () => {
        try {
          const res = await fetch('/api/files/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath }),
          });
          const data = await res.json();
          if (data.ok) {
            window.showToast(`${name} deleted`);
            fmLoad(currentPath);
          } else {
            window.showToast(`Error: ${data.error}`, true);
          }
        } catch (err) {
          window.showToast(`Error: ${err.message}`, true);
        }
      }
    );
  }

  window.fmLoad = fmLoad;
  window.fmEdit = fmEdit;
  window.fmSave = fmSave;
  window.fmUp = fmUp;
  window.fmRefresh = fmRefresh;
  window.fmDownload = fmDownload;
  window.fmDelete = fmDelete;
})();
