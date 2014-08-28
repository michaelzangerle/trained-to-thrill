this.addEventListener('fetch', function(event) {
  event.respondWith(
    new Response('<h1>Sorry</h1> No trains today', {
      headers: {'Content-Type': 'text/html'}
    })
  );
});
