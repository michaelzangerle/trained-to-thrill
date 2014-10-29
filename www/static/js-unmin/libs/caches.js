// Cannot feature-detect, as we have these implemented but they reject
Cache.prototype.add = function add(request) {
  return this.addAll([request]);
};

Cache.prototype.addAll = function addAll(requests) {
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

    requests.forEach(function(request) {
      if (request instanceof Request) {
        sequence.push(request);
      }
      else {
        sequence.push(String(request)); // may throw TypeError
      }
    });

    requests = sequence;

    return Promise.all(
      requests.map(function(request) {
        if (typeof request === 'string') {
          request = new Request(request);
        }

        var scheme = new URL(request.url).protocol;

        if (scheme !== 'http:' && scheme !== 'https:') {
          throw new NetworkError("Invalid scheme");
        }

        return fetch(request);
      })
    );
  }.bind(this)).then(function(responses) {
    // TODO: check that requests don't overwrite one another
    // (don't think this is possible to polyfill due to opaque responses)
    return Promise.all(
      responses.map(function(response, i) {
        this.put(requests[i], response);
      }.bind(this))
    );
  }.bind(this)).then(function() {
    return undefined;
  });
};

// Also creating race conditions here
/* Nope: cache.delete not implemented yet
var cachePut = Cache.prototype.put;
Cache.prototype.put = function(request, response) {
  return cache.delete(request).then(function() {
    return cachePut.call(this, request, response);
  }.bind(this));
};
*/

if (!CacheStorage.prototype.match) {
  // This is probably vulnerable to race conditions (removing caches etc)
  CacheStorage.prototype.match = function match(request, opts) {
    return this.keys().then(function(cacheNames) {
      var match;
      return cacheNames.reduce(function(chain, cacheName) {
        return chain.then(function() {
          return match || this.open(cacheName).then(function(cache) {
            return cache.match(request, opts);
          }.bind(this)).then(function(response) {
            match = response;
          }.bind(this));
        }.bind(this));
      }.bind(this), Promise.resolve());
    });
  };
}

module.exports = self.caches;