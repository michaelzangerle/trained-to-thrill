self.addEventListener('fetch', function(event) {
  var requestURL = new URL(event.request.url);

  if (/\.staticflickr\.com$/.test(requestURL.hostname)) {
    event.respondWith(fetch('../imgs/thomas.jpg'));
  }
});
