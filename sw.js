// Virtual filesystem metadata (no file content in memory)
let vfs = {
  type: 'folder',
  children: {}
};

const DB_NAME = 'VFS_Storage';
const DB_VERSION = 1;
const METADATA_STORE = 'metadata';
const FILES_STORE = 'files';

// Initialize IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE);
      }
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE);
      }
    };
  });
}

// Save VFS metadata to IndexedDB
async function saveMetadata() {
  try {
    const db = await openDB();
    const tx = db.transaction(METADATA_STORE, 'readwrite');
    const store = tx.objectStore(METADATA_STORE);
    store.put(vfs, 'vfs_root');
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log('VFS metadata saved to IndexedDB');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to save metadata:', err);
  }
}

// Load VFS metadata from IndexedDB
async function loadMetadata() {
  try {
    const db = await openDB();
    const tx = db.transaction(METADATA_STORE, 'readonly');
    const store = tx.objectStore(METADATA_STORE);
    const request = store.get('vfs_root');
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        if (request.result) {
          vfs = request.result;
          console.log('VFS metadata loaded from IndexedDB');
        }
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to load metadata:', err);
  }
}

// Save file data to IndexedDB
async function saveFileData(fileId, arrayBuffer) {
  try {
    const db = await openDB();
    const tx = db.transaction(FILES_STORE, 'readwrite');
    const store = tx.objectStore(FILES_STORE);
    store.put(arrayBuffer, fileId);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to save file data:', err);
  }
}

// Load file data from IndexedDB
async function loadFileData(fileId) {
  try {
    const db = await openDB();
    const tx = db.transaction(FILES_STORE, 'readonly');
    const store = tx.objectStore(FILES_STORE);
    const request = store.get(fileId);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to load file data:', err);
    return null;
  }
}

// Delete file data from IndexedDB
async function deleteFileData(fileId) {
  try {
    const db = await openDB();
    const tx = db.transaction(FILES_STORE, 'readwrite');
    const store = tx.objectStore(FILES_STORE);
    store.delete(fileId);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to delete file data:', err);
  }
}

// Generate unique file ID
function generateFileId() {
  return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('Service Worker activated');
  event.waitUntil(
    loadMetadata().then(() => clients.claim())
  );
});

// Parse path into parts
function parsePath(path) {
  return path.split('/').filter(Boolean);
}

// Navigate to a node in the tree
function navigateToNode(path, createIfMissing = false) {
  const parts = parsePath(path);
  let current = vfs;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    
    if (!current.children[part]) {
      if (createIfMissing) {
        current.children[part] = { type: 'folder', children: {} };
      } else {
        return null;
      }
    }
    
    if (current.children[part].type !== 'folder') {
      return null;
    }
    
    current = current.children[part];
  }
  
  return { parent: current, name: parts[parts.length - 1] };
}

// Get file metadata from VFS
function getFileMetadata(path) {
  const result = navigateToNode(path);
  if (!result) return null;
  
  const node = result.parent.children[result.name];
  if (node && node.type === 'file') {
    return node;
  }
  
  return null;
}

// Delete file and all its data recursively
async function deleteItemRecursive(node) {
  if (node.type === 'file') {
    await deleteFileData(node.fileId);
  } else if (node.type === 'folder') {
    for (const child of Object.values(node.children)) {
      await deleteItemRecursive(child);
    }
  }
}

// Reset the entire VFS
async function resetVFS() {
  // Delete all file data
  await deleteItemRecursive(vfs);
  
  // Clear metadata
  vfs.children = {};
  await saveMetadata();
  
  // Clear all file data from IndexedDB
  try {
    const db = await openDB();
    const tx = db.transaction(FILES_STORE, 'readwrite');
    const store = tx.objectStore(FILES_STORE);
    store.clear();
    await new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (err) {
    console.error('Failed to clear files:', err);
  }
  
  console.log('VFS reset - all files and folders deleted');
}

// Handle fetch requests
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  if (url.pathname.startsWith('/vfs/')) {
    const path = url.pathname.substring(4); // Remove '/vfs'
    
    event.respondWith(
      (async () => {
        const fileMeta = getFileMetadata(path);
        
        if (fileMeta) {
          // Load file data on demand from IndexedDB
          const fileData = await loadFileData(fileMeta.fileId);
          
          if (fileData) {
            return new Response(fileData, {
              headers: {
                'Content-Type': fileMeta.mimeType || 'application/octet-stream',
                'Content-Length': fileMeta.size
              }
            });
          } else {
            return new Response('File data not found', { status: 500 });
          }
        } else {
          return new Response('File not found', { status: 404 });
        }
      })()
    );
    return;
  }
  
  event.respondWith(fetch(event.request));
});

// Handle messages from UI
self.addEventListener('message', event => {
  const { type, path, data } = event.data;
  
  switch (type) {
    case 'UPLOAD_FILE':
      (async () => {
        const fileResult = navigateToNode(path, true);
        if (fileResult) {
          const fileId = generateFileId();
          
          // Save file data to IndexedDB
          await saveFileData(fileId, data.buffer);
          
          // Store only metadata in memory
          fileResult.parent.children[fileResult.name] = {
            type: 'file',
            fileId: fileId,
            mimeType: getMimeType(path),
            size: data.byteLength
          };
          
          console.log(`File uploaded: ${path} (${data.byteLength} bytes, ID: ${fileId})`);
          await saveMetadata();
        }
      })();
      break;
      
    case 'CREATE_FOLDER':
      (async () => {
        const folderResult = navigateToNode(path, true);
        if (folderResult && !folderResult.parent.children[folderResult.name]) {
          folderResult.parent.children[folderResult.name] = {
            type: 'folder',
            children: {}
          };
          console.log(`Folder created: ${path}`);
          await saveMetadata();
        }
      })();
      break;
      
    case 'DELETE_ITEM':
      (async () => {
        const deleteResult = navigateToNode(path);
        if (deleteResult) {
          const node = deleteResult.parent.children[deleteResult.name];
          
          // Delete all file data recursively
          await deleteItemRecursive(node);
          
          // Delete from tree
          delete deleteResult.parent.children[deleteResult.name];
          console.log(`Item deleted: ${path}`);
          await saveMetadata();
        }
      })();
      break;
      
    case 'RESET_VFS':
      resetVFS();
      break;
      
    case 'GET_TREE':
      event.source.postMessage({
        type: 'FILE_TREE',
        tree: vfs.children
      });
      break;
  }
});

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    'txt': 'text/plain',
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'pdf': 'application/pdf',
    'zip': 'application/zip',
    'wasm': 'application/wasm'
  };
  return types[ext] || 'application/octet-stream';
}
