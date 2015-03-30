var caches = require('../libs/caches');

/**
 * Install service worker
 * @param event
 */
self.oninstall = function(event) {
    // sw will be treated as installed when all code in waitUntil is processes
  event.waitUntil(
      // create / open cache with specific key
    caches.open('trains-static-v14').then(function(cache) {
        // add all resources with following url
      return cache.addAll([
        '/trained-to-thrill/',
        '/trained-to-thrill/static/css/all.css',
        '/trained-to-thrill/static/js/page.js',
        '/trained-to-thrill/static/imgs/logo.svg',
        '/trained-to-thrill/static/imgs/icon.png'
      ]);
    })
  );
};

var expectedCaches = [
  'trains-static-v14',
  'trains-imgs',
  'trains-data'
];

/**
 * Will be useful when updating sw - removes old caches
 * @param event
 */
self.onactivate = function(event) {
  // remove caches beginning "trains-" that aren't in
  // expectedCaches
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          if (!/^trains-/.test(cacheName)) {
            return;
          }
          if (expectedCaches.indexOf(cacheName) == -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
};

/**
 * Handles requests by directing them to the in  ternet or the cache
 * @param event
 */
self.onfetch = function(event) {
  var requestURL = new URL(event.request.url);

  if (requestURL.hostname == 'api.flickr.com') {
    event.respondWith(flickrAPIResponse(event.request));
  }
  else if (/\.staticflickr\.com$/.test(requestURL.hostname)) {
    event.respondWith(flickrImageResponse(event.request));
  }
  else {
    event.respondWith(
      caches.match(event.request, {
        ignoreVary: true
      })
    );
  }
};

/**
 * Returns a response on a request to the flickr api
 * The request will be used to determine which images can be
 * deleted from the cache safely and the response to the request
 * will be added to the cache
 * @param request
 * @returns {*}
 */
function flickrAPIResponse(request) {
  if (request.headers.get('Accept') == 'x-cache/only') {
    return caches.match(request);
  }
  else {
    return fetch(request.clone()).then(function(response) {
      return caches.open('trains-data').then(function(cache) {
        // clean up the image cache
        Promise.all([
          response.clone().json(),
          caches.open('trains-imgs')
        ]).then(function(results) {
          var data = results[0];
          var imgCache = results[1];

          var imgURLs = data.photos.photo.map(function(photo) {
            return 'https://farm' + photo.farm + '.staticflickr.com/' + photo.server + '/' + photo.id + '_' + photo.secret + '_c.jpg';
          });

          // if an item in the cache *isn't* in imgURLs, delete it
          imgCache.keys().then(function(requests) {
            requests.forEach(function(request) {
              if (imgURLs.indexOf(request.url) == -1) {
                imgCache.delete(request);
              }
            });
          });
        });

        cache.put(request, response.clone()).then(function() {
          console.log("Yey cache");
        }, function() {
          console.log("Nay cache");
        });

        return response;
      });
    });
  }
}

/**
 * Request for actual images which will look for a request match in the cache
 * and return the cache if it exists or triggers a fetch for this request. The
 * response of the request will be added to the cache.
 * @param request
 * @returns {Promise}
 */
function flickrImageResponse(request) {
  return caches.match(request).then(function(response) {
    if (response) {
      return response;
    }

    return fetch(request.clone()).then(function(response) {
      caches.open('trains-imgs').then(function(cache) {
        cache.put(request, response).then(function() {
          console.log('yey img cache');
        }, function() {
          console.log('nay img cache');
        });
      });

      return response.clone();
    });
  });
}
