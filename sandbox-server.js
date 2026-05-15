const http = require('http');
const fs = require('fs');
const path = require('path');

const port = 5000;
const baseDir = path.join(__dirname, 'packages', 'client', 'sandbox');

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let filePath = path.join(baseDir, url.pathname === '/' ? 'index.html' : url.pathname);
  
  // Basic MIME types
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(port, () => {
  console.log(`Sandbox serving on port ${port}`);
  console.log(`Base directory: ${baseDir}`);
});
