(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
// Cannot feature-detect, as we have these implemented but they reject

if (!Cache.prototype.add) {
  Cache.prototype.add = function add(request) {
    return this.addAll([request]);
  };
}

if (!Cache.prototype.addAll) {
  Cache.prototype.addAll = function addAll(requests) {
    var cache = this;

    // Since DOMExceptions are not constructable:
    function NetworkError(message) {
      this.name = 'NetworkError';
      this.code = 19;
      this.message = message;
    }
    NetworkError.prototype = Object.create(Error.prototype);

    return Promise.resolve().then(function() {
      if (arguments.length < 1) throw new TypeError();
      
      // Simulate sequence<(Request or USVString)> binding:
      var sequence = [];

      requests = requests.map(function(request) {
        if (request instanceof Request) {
          return request;
        }
        else {
          return String(request); // may throw TypeError
        }
      });

      return Promise.all(
        requests.map(function(request) {
          if (typeof request === 'string') {
            request = new Request(request);
          }

          var scheme = new URL(request.url).protocol;

          if (scheme !== 'http:' && scheme !== 'https:') {
            throw new NetworkError("Invalid scheme");
          }

          return fetch(request.clone());
        })
      );
    }).then(function(responses) {
      // TODO: check that requests don't overwrite one another
      // (don't think this is possible to polyfill due to opaque responses)
      return Promise.all(
        responses.map(function(response, i) {
          return cache.put(requests[i], response);
        })
      );
    }).then(function() {
      return undefined;
    });
  };
}

if (!CacheStorage.prototype.match) {
  // This is probably vulnerable to race conditions (removing caches etc)
  CacheStorage.prototype.match = function match(request, opts) {
    var caches = this;

    return this.keys().then(function(cacheNames) {
      var match;

      return cacheNames.reduce(function(chain, cacheName) {
        return chain.then(function() {
          return match || caches.open(cacheName).then(function(cache) {
            return cache.match(request, opts);
          }).then(function(response) {
            match = response;
            return match;
          });
        });
      }, Promise.resolve());
    });
  };
}

module.exports = self.caches;
},{}],2:[function(require,module,exports){
var caches = require('../libs/caches');

self.oninstall = function(event) {
  event.waitUntil(
    caches.open('trains-static-v14').then(function(cache) {
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

function flickrAPIResponse(request) {
  if (request.headers.get('Accept') == 'x-cache/only') {
    return caches.match(request);
  }
  else {
    return fetch(request).then(function(response) {
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

function flickrImageResponse(request) {
  return caches.match(request).then(function(response) {
    if (response) {
      return response;
    }

    return fetch(request).then(function(response) {
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

},{"../libs/caches":1}]},{},[2])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvdHJhaW5lZC10by10aHJpbGwvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi90cmFpbmVkLXRvLXRocmlsbC93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvY2FjaGVzLmpzIiwiL1VzZXJzL2pha2VhcmNoaWJhbGQvZGV2L3RyYWluZWQtdG8tdGhyaWxsL3d3dy9zdGF0aWMvanMtdW5taW4vc3cvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLy8gQ2Fubm90IGZlYXR1cmUtZGV0ZWN0LCBhcyB3ZSBoYXZlIHRoZXNlIGltcGxlbWVudGVkIGJ1dCB0aGV5IHJlamVjdFxuXG5pZiAoIUNhY2hlLnByb3RvdHlwZS5hZGQpIHtcbiAgQ2FjaGUucHJvdG90eXBlLmFkZCA9IGZ1bmN0aW9uIGFkZChyZXF1ZXN0KSB7XG4gICAgcmV0dXJuIHRoaXMuYWRkQWxsKFtyZXF1ZXN0XSk7XG4gIH07XG59XG5cbmlmICghQ2FjaGUucHJvdG90eXBlLmFkZEFsbCkge1xuICBDYWNoZS5wcm90b3R5cGUuYWRkQWxsID0gZnVuY3Rpb24gYWRkQWxsKHJlcXVlc3RzKSB7XG4gICAgdmFyIGNhY2hlID0gdGhpcztcblxuICAgIC8vIFNpbmNlIERPTUV4Y2VwdGlvbnMgYXJlIG5vdCBjb25zdHJ1Y3RhYmxlOlxuICAgIGZ1bmN0aW9uIE5ldHdvcmtFcnJvcihtZXNzYWdlKSB7XG4gICAgICB0aGlzLm5hbWUgPSAnTmV0d29ya0Vycm9yJztcbiAgICAgIHRoaXMuY29kZSA9IDE5O1xuICAgICAgdGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcbiAgICB9XG4gICAgTmV0d29ya0Vycm9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoRXJyb3IucHJvdG90eXBlKTtcblxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPCAxKSB0aHJvdyBuZXcgVHlwZUVycm9yKCk7XG4gICAgICBcbiAgICAgIC8vIFNpbXVsYXRlIHNlcXVlbmNlPChSZXF1ZXN0IG9yIFVTVlN0cmluZyk+IGJpbmRpbmc6XG4gICAgICB2YXIgc2VxdWVuY2UgPSBbXTtcblxuICAgICAgcmVxdWVzdHMgPSByZXF1ZXN0cy5tYXAoZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgICBpZiAocmVxdWVzdCBpbnN0YW5jZW9mIFJlcXVlc3QpIHtcbiAgICAgICAgICByZXR1cm4gcmVxdWVzdDtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gU3RyaW5nKHJlcXVlc3QpOyAvLyBtYXkgdGhyb3cgVHlwZUVycm9yXG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiByZXF1ZXN0ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgcmVxdWVzdCA9IG5ldyBSZXF1ZXN0KHJlcXVlc3QpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHZhciBzY2hlbWUgPSBuZXcgVVJMKHJlcXVlc3QudXJsKS5wcm90b2NvbDtcblxuICAgICAgICAgIGlmIChzY2hlbWUgIT09ICdodHRwOicgJiYgc2NoZW1lICE9PSAnaHR0cHM6Jykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE5ldHdvcmtFcnJvcihcIkludmFsaWQgc2NoZW1lXCIpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0LmNsb25lKCkpO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xuICAgICAgLy8gVE9ETzogY2hlY2sgdGhhdCByZXF1ZXN0cyBkb24ndCBvdmVyd3JpdGUgb25lIGFub3RoZXJcbiAgICAgIC8vIChkb24ndCB0aGluayB0aGlzIGlzIHBvc3NpYmxlIHRvIHBvbHlmaWxsIGR1ZSB0byBvcGFxdWUgcmVzcG9uc2VzKVxuICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICByZXNwb25zZXMubWFwKGZ1bmN0aW9uKHJlc3BvbnNlLCBpKSB7XG4gICAgICAgICAgcmV0dXJuIGNhY2hlLnB1dChyZXF1ZXN0c1tpXSwgcmVzcG9uc2UpO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9KTtcbiAgfTtcbn1cblxuaWYgKCFDYWNoZVN0b3JhZ2UucHJvdG90eXBlLm1hdGNoKSB7XG4gIC8vIFRoaXMgaXMgcHJvYmFibHkgdnVsbmVyYWJsZSB0byByYWNlIGNvbmRpdGlvbnMgKHJlbW92aW5nIGNhY2hlcyBldGMpXG4gIENhY2hlU3RvcmFnZS5wcm90b3R5cGUubWF0Y2ggPSBmdW5jdGlvbiBtYXRjaChyZXF1ZXN0LCBvcHRzKSB7XG4gICAgdmFyIGNhY2hlcyA9IHRoaXM7XG5cbiAgICByZXR1cm4gdGhpcy5rZXlzKCkudGhlbihmdW5jdGlvbihjYWNoZU5hbWVzKSB7XG4gICAgICB2YXIgbWF0Y2g7XG5cbiAgICAgIHJldHVybiBjYWNoZU5hbWVzLnJlZHVjZShmdW5jdGlvbihjaGFpbiwgY2FjaGVOYW1lKSB7XG4gICAgICAgIHJldHVybiBjaGFpbi50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHJldHVybiBtYXRjaCB8fCBjYWNoZXMub3BlbihjYWNoZU5hbWUpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjYWNoZS5tYXRjaChyZXF1ZXN0LCBvcHRzKTtcbiAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgICAgICBtYXRjaCA9IHJlc3BvbnNlO1xuICAgICAgICAgICAgcmV0dXJuIG1hdGNoO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgIH0sIFByb21pc2UucmVzb2x2ZSgpKTtcbiAgICB9KTtcbiAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBzZWxmLmNhY2hlczsiLCJ2YXIgY2FjaGVzID0gcmVxdWlyZSgnLi4vbGlicy9jYWNoZXMnKTtcblxuc2VsZi5vbmluc3RhbGwgPSBmdW5jdGlvbihldmVudCkge1xuICBldmVudC53YWl0VW50aWwoXG4gICAgY2FjaGVzLm9wZW4oJ3RyYWlucy1zdGF0aWMtdjE0JykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgcmV0dXJuIGNhY2hlLmFkZEFsbChbXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvY3NzL2FsbC5jc3MnLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9qcy9wYWdlLmpzJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvaW1ncy9sb2dvLnN2ZycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2ltZ3MvaWNvbi5wbmcnXG4gICAgICBdKTtcbiAgICB9KVxuICApO1xufTtcblxudmFyIGV4cGVjdGVkQ2FjaGVzID0gW1xuICAndHJhaW5zLXN0YXRpYy12MTQnLFxuICAndHJhaW5zLWltZ3MnLFxuICAndHJhaW5zLWRhdGEnXG5dO1xuXG5zZWxmLm9uYWN0aXZhdGUgPSBmdW5jdGlvbihldmVudCkge1xuICAvLyByZW1vdmUgY2FjaGVzIGJlZ2lubmluZyBcInRyYWlucy1cIiB0aGF0IGFyZW4ndCBpblxuICAvLyBleHBlY3RlZENhY2hlc1xuICBldmVudC53YWl0VW50aWwoXG4gICAgY2FjaGVzLmtleXMoKS50aGVuKGZ1bmN0aW9uKGNhY2hlTmFtZXMpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgY2FjaGVOYW1lcy5tYXAoZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gICAgICAgICAgaWYgKCEvXnRyYWlucy0vLnRlc3QoY2FjaGVOYW1lKSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZXhwZWN0ZWRDYWNoZXMuaW5kZXhPZihjYWNoZU5hbWUpID09IC0xKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZShjYWNoZU5hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfSlcbiAgKTtcbn07XG5cbnNlbGYub25mZXRjaCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gIHZhciByZXF1ZXN0VVJMID0gbmV3IFVSTChldmVudC5yZXF1ZXN0LnVybCk7XG5cbiAgaWYgKHJlcXVlc3RVUkwuaG9zdG5hbWUgPT0gJ2FwaS5mbGlja3IuY29tJykge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckFQSVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIGlmICgvXFwuc3RhdGljZmxpY2tyXFwuY29tJC8udGVzdChyZXF1ZXN0VVJMLmhvc3RuYW1lKSkge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckltYWdlUmVzcG9uc2UoZXZlbnQucmVxdWVzdCkpO1xuICB9XG4gIGVsc2Uge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKFxuICAgICAgY2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QsIHtcbiAgICAgICAgaWdub3JlVmFyeTogdHJ1ZVxuICAgICAgfSlcbiAgICApO1xuICB9XG59O1xuXG5mdW5jdGlvbiBmbGlja3JBUElSZXNwb25zZShyZXF1ZXN0KSB7XG4gIGlmIChyZXF1ZXN0LmhlYWRlcnMuZ2V0KCdBY2NlcHQnKSA9PSAneC1jYWNoZS9vbmx5Jykge1xuICAgIHJldHVybiBjYWNoZXMubWF0Y2gocmVxdWVzdCk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGZldGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIHJldHVybiBjYWNoZXMub3BlbigndHJhaW5zLWRhdGEnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIC8vIGNsZWFuIHVwIHRoZSBpbWFnZSBjYWNoZVxuICAgICAgICBQcm9taXNlLmFsbChbXG4gICAgICAgICAgcmVzcG9uc2UuY2xvbmUoKS5qc29uKCksXG4gICAgICAgICAgY2FjaGVzLm9wZW4oJ3RyYWlucy1pbWdzJylcbiAgICAgICAgXSkudGhlbihmdW5jdGlvbihyZXN1bHRzKSB7XG4gICAgICAgICAgdmFyIGRhdGEgPSByZXN1bHRzWzBdO1xuICAgICAgICAgIHZhciBpbWdDYWNoZSA9IHJlc3VsdHNbMV07XG5cbiAgICAgICAgICB2YXIgaW1nVVJMcyA9IGRhdGEucGhvdG9zLnBob3RvLm1hcChmdW5jdGlvbihwaG90bykge1xuICAgICAgICAgICAgcmV0dXJuICdodHRwczovL2Zhcm0nICsgcGhvdG8uZmFybSArICcuc3RhdGljZmxpY2tyLmNvbS8nICsgcGhvdG8uc2VydmVyICsgJy8nICsgcGhvdG8uaWQgKyAnXycgKyBwaG90by5zZWNyZXQgKyAnX2MuanBnJztcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIC8vIGlmIGFuIGl0ZW0gaW4gdGhlIGNhY2hlICppc24ndCogaW4gaW1nVVJMcywgZGVsZXRlIGl0XG4gICAgICAgICAgaW1nQ2FjaGUua2V5cygpLnRoZW4oZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgICAgICAgICAgIHJlcXVlc3RzLmZvckVhY2goZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgICAgICAgICBpZiAoaW1nVVJMcy5pbmRleE9mKHJlcXVlc3QudXJsKSA9PSAtMSkge1xuICAgICAgICAgICAgICAgIGltZ0NhY2hlLmRlbGV0ZShyZXF1ZXN0KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZS5jbG9uZSgpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKFwiWWV5IGNhY2hlXCIpO1xuICAgICAgICB9LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICBjb25zb2xlLmxvZyhcIk5heSBjYWNoZVwiKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmxpY2tySW1hZ2VSZXNwb25zZShyZXF1ZXN0KSB7XG4gIHJldHVybiBjYWNoZXMubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH1cblxuICAgIHJldHVybiBmZXRjaChyZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICBjYWNoZXMub3BlbigndHJhaW5zLWltZ3MnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZSkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICBjb25zb2xlLmxvZygneWV5IGltZyBjYWNoZScpO1xuICAgICAgICB9LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICBjb25zb2xlLmxvZygnbmF5IGltZyBjYWNoZScpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gcmVzcG9uc2UuY2xvbmUoKTtcbiAgICB9KTtcbiAgfSk7XG59XG4iXX0=
