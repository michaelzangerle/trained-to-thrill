(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var cacheDB = require('./cachedb');

function Cache() {
  this._name = '';
  this._origin = '';
}

var CacheProto = Cache.prototype;

CacheProto.match = function(request, params) {
  return cacheDB.match(this._origin, this._name, request, params);
};

CacheProto.matchAll = function(request, params) {
  return cacheDB.matchAll(this._origin, this._name, request, params);
};

CacheProto.addAll = function(requests) {
  Promise.all(
    requests.map(function(request) {
      return fetch(request);
    })
  ).then(function(responses) {
    return cacheDB.put(this._origin, this._name, responses.map(function(response, i) {
      return [requests[i], response];
    }));
  }.bind(this));
};

CacheProto.add = function(request) {
  return this.addAll([request]);
};

CacheProto.put = function(request, response) {
  if (!(response instanceof Response)) {
    throw TypeError("Incorrect response type");
  }

  return cacheDB.put(this._origin, this._name, [[request, response]]);
};

CacheProto.delete = function(request, params) {
  return cacheDB.delete(this._origin, this._name, request, params);
};

CacheProto.keys = function(request, params) {
  if (request) {
    return cacheDB.matchAllRequests(this._origin, this._name, request, params);
  }
  else {
    return cacheDB.allRequests(this._origin, this._name);
  }
};

module.exports = Cache;

},{"./cachedb":2}],2:[function(require,module,exports){
var IDBHelper = require('./idbhelper');

function matchesVary(request, entryRequest, entryResponse) {
  if (!entryResponse.headers.vary) {
    return true;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;
  var requestHeaders = {};

  for (var header of request.headers) {
    requestHeaders[header[0].toLowerCase()] = header[1];
  }

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    if (entryRequest.headers[varyHeader] != requestHeaders[varyHeader]) {
      return false;
    }
  }
  return true;
}

function createVaryID(entryRequest, entryResponse) {
  var id = '';

  if (!entryResponse.headers.vary) {
    return id;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    id += varyHeader + ': ' + (entryRequest.headers[varyHeader] || '') + '\n';
  }

  return id;
}

function flattenHeaders(headers) {
  var returnVal = {};

  for (var header of headers) {
    returnVal[header[0].toLowerCase()] = header[1];
  }

  return returnVal;
}

function entryToResponse(entry) {
  var entryResponse = entry.response;
  return new Response(entryResponse.body, {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, body) {
  return {
    body: body,
    status: response.status,
    statusText: response.statusText,
    headers: flattenHeaders(response.headers)
  };
}

function entryToRequest(entry) {
  var entryRequest = entry.request;
  return new Request(entryRequest.url, {
    mode: entryRequest.mode,
    headers: entryRequest.headers,
    credentials: entryRequest.headers
  });
}

function requestToEntry(request) {
  return {
    url: request.url,
    mode: request.mode,
    credentials: request.credentials,
    headers: flattenHeaders(request.headers)
  };
}

function castToRequest(request) {
  if (!(request instanceof Request)) {
    request = new Request(request);
  }
  return request;
}

function CacheDB() {
  this.db = new IDBHelper('cache-polyfill', 1, function(db, oldVersion) {
    switch (oldVersion) {
      case 0:
        var namesStore = db.createObjectStore('cacheNames', {
          keyPath: ['origin', 'name']
        });
        namesStore.createIndex('origin', ['origin', 'added']);

        var entryStore = db.createObjectStore('cacheEntries', {
          keyPath: ['origin', 'cacheName', 'request.url', 'varyID']
        });
        entryStore.createIndex('origin-cacheName', ['origin', 'cacheName', 'added']);
        entryStore.createIndex('origin-cacheName-urlNoSearch', ['origin', 'cacheName', 'requestUrlNoSearch', 'added']);
        entryStore.createIndex('origin-cacheName-url', ['origin', 'cacheName', 'request.url', 'added']);
    }
  });
}

var CacheDBProto = CacheDB.prototype;

CacheDBProto._eachCache = function(tx, origin, eachCallback, doneCallback, errorCallback) {
  IDBHelper.iterate(
    tx.objectStore('cacheNames').index('origin').openCursor(IDBKeyRange.bound([origin, 0], [origin, Infinity])),
    eachCallback, doneCallback, errorCallback
  );
};

CacheDBProto._eachMatch = function(tx, origin, cacheName, request, eachCallback, doneCallback, errorCallback, params) {
  params = params || {};

  var ignoreSearch = Boolean(params.ignoreSearch);
  var ignoreMethod = Boolean(params.ignoreMethod);
  var ignoreVary = Boolean(params.ignoreVary);
  var prefixMatch = Boolean(params.prefixMatch);

  if (!ignoreMethod &&
      request.method !== 'GET' &&
      request.method !== 'HEAD') {
    // we only store GET responses at the moment, so no match
    return Promise.resolve();
  }

  var cacheEntries = tx.objectStore('cacheEntries');
  var range;
  var index;
  var indexName = 'origin-cacheName-url';
  var urlToMatch = new URL(request.url);

  urlToMatch.hash = '';

  if (ignoreSearch) {
    urlToMatch.search = '';
    indexName += 'NoSearch';
  }

  // working around chrome bugs
  urlToMatch = urlToMatch.href.replace(/(\?|#|\?#)$/, '');

  index = cacheEntries.index(indexName);

  if (prefixMatch) {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch + String.fromCharCode(65535), Infinity]);
  }
  else {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch, Infinity]);
  }

  IDBHelper.iterate(index.openCursor(range), function(cursor) {
    var value = cursor.value;
    
    if (ignoreVary || matchesVary(request, cursor.value.request, cursor.value.response)) {
      eachCallback(cursor);
    }
    else {
      cursor.continue();
    }
  }, doneCallback, errorCallback);
};

CacheDBProto._hasCache = function(tx, origin, cacheName, doneCallback, errCallback) {
  var store = tx.objectStore('cacheNames');
  return IDBHelper.callbackify(store.get([origin, cacheName]), function(val) {
    doneCallback(!!val);
  }, errCallback);
};

CacheDBProto._delete = function(tx, origin, cacheName, request, doneCallback, errCallback, params) {
  var returnVal = false;

  this._eachMatch(tx, origin, cacheName, request, function(cursor) {
    returnVal = true;
    cursor.delete();
  }, function() {
    if (doneCallback) {
      doneCallback(returnVal);
    }
  }, errCallback, params);
};

CacheDBProto.matchAllRequests = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.key);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.allRequests = function(origin, cacheName) {
  var matches = [];

  return this.db.transaction('cacheEntries', function(tx) {
    var cacheEntries = tx.objectStore('cacheEntries');
    var index = cacheEntries.index('origin-cacheName');

    IDBHelper.iterate(index.openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])), function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    });
  }).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.matchAll = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToResponse);
  });
};

CacheDBProto.match = function(origin, cacheName, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      match = cursor.value;
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.matchAcrossCaches = function(origin, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      var cacheName = cursor.value.name;

      this._eachMatch(tx, origin, cacheName, request, function(cursor) {
        match = cursor.value;
        // we're done
      }, undefined, undefined, params);

      if (!match) { // continue if no match
        cursor.continue();
      }
    }.bind(this));
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.cacheNames = function(origin) {
  var names = [];

  return this.db.transaction('cacheNames', function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      names.push(cursor.value.name);
      cursor.continue();
    }.bind(this));
  }.bind(this)).then(function() {
    return names;
  });
};

CacheDBProto.delete = function(origin, cacheName, request, params) {
  var returnVal;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._delete(tx, origin, cacheName, request, params, function(v) {
      returnVal = v;
    });
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.openCache = function(origin, cacheName) {
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      if (val) { return; }
      var store = tx.objectStore('cacheNames');
      store.add({
        origin: origin,
        name: cacheName,
        added: Date.now()
      });
    });
  }.bind(this), {mode: 'readwrite'});
};

CacheDBProto.hasCache = function(origin, cacheName) {
  var returnVal;
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      returnVal = val;
    });
  }.bind(this)).then(function(val) {
    return returnVal;
  });
};

CacheDBProto.deleteCache = function(origin, cacheName) {
  var returnVal = false;

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    IDBHelper.iterate(
      tx.objectStore('cacheNames').openCursor(IDBKeyRange.only([origin, cacheName])),
      del
    );

    IDBHelper.iterate(
      tx.objectStore('cacheEntries').index('origin-cacheName').openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])),
      del
    );

    function del(cursor) {
      returnVal = true;
      cursor.delete();
      cursor.continue();
    }
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.put = function(origin, cacheName, items) {
  // items is [[request, response], [request, response], …]
  var item;

  for (var i = 0; i < items.length; i++) {
    items[i][0] = castToRequest(items[i][0]);

    if (items[i][0].method != 'GET') {
      return Promise.reject(TypeError('Only GET requests are supported'));
    }

    // ensure each entry being put won't overwrite earlier entries being put
    for (var j = 0; j < i; j++) {
      if (items[i][0].url == items[j][0].url && matchesVary(items[j][0], items[i][0], items[i][1])) {
        return Promise.reject(TypeError('Puts would overwrite eachother'));
      }
    }
  }

  return Promise.all(
    items.map(function(item) {
      return item[1].blob();
    })
  ).then(function(responseBodies) {
    return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
      this._hasCache(tx, origin, cacheName, function(hasCache) {
        if (!hasCache) {
          throw Error("Cache of that name does not exist");
        }

        items.forEach(function(item, i) {
          var request = item[0];
          var response = item[1];
          var requestEntry = requestToEntry(request);
          var responseEntry = responseToEntry(response, responseBodies[i]);

          var requestUrlNoSearch = new URL(request.url);
          requestUrlNoSearch.search = '';
          // working around Chrome bug
          requestUrlNoSearch = requestUrlNoSearch.href.replace(/\?$/, '');

          this._delete(tx, origin, cacheName, request, function() {
            tx.objectStore('cacheEntries').add({
              origin: origin,
              cacheName: cacheName,
              request: requestEntry,
              response: responseEntry,
              requestUrlNoSearch: requestUrlNoSearch,
              varyID: createVaryID(requestEntry, responseEntry),
              added: Date.now()
            });
          });

        }.bind(this));
      }.bind(this));
    }.bind(this), {mode: 'readwrite'});
  }.bind(this)).then(function() {
    return undefined;
  });
};

module.exports = new CacheDB();
},{"./idbhelper":4}],3:[function(require,module,exports){
var cacheDB = require('./cachedb');
var Cache = require('./cache');

function CacheStorage() {
  this._origin = location.origin;
}

var CacheStorageProto = CacheStorage.prototype;

CacheStorageProto._vendCache = function(name) {
  var cache = new Cache();
  cache._name = name;
  cache._origin = this._origin;
  return cache;
};

CacheStorageProto.match = function(request, params) {
  return cacheDB.matchAcrossCaches(this._origin, request, params);
};

CacheStorageProto.has = function(name) {
  return cacheDB.hasCache(this._origin, name);
};

CacheStorageProto.open = function(name) {
  return cacheDB.openCache(this._origin, name).then(function() {
    return this._vendCache(name);
  }.bind(this));
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(this._origin, name);
};

CacheStorageProto.keys = function() {
  return cacheDB.cacheNames(this._origin);
};

self.cachesPolyfill = module.exports = new CacheStorage();

},{"./cache":1,"./cachedb":2}],4:[function(require,module,exports){
function IDBHelper(name, version, upgradeCallback) {
  var request = indexedDB.open(name, version);
  this.ready = IDBHelper.promisify(request);
  request.onupgradeneeded = function(event) {
    upgradeCallback(request.result, event.oldVersion);
  };
}

IDBHelper.supported = 'indexedDB' in self;

IDBHelper.promisify = function(obj) {
  return new Promise(function(resolve, reject) {
    IDBHelper.callbackify(obj, resolve, reject);
  });
};

IDBHelper.callbackify = function(obj, doneCallback, errCallback) {
  function onsuccess(event) {
    if (doneCallback) {
      doneCallback(obj.result);
    }
    unlisten();
  }
  function onerror(event) {
    if (errCallback) {
      errCallback(obj.error);
    }
    unlisten();
  }
  function unlisten() {
    obj.removeEventListener('complete', onsuccess);
    obj.removeEventListener('success', onsuccess);
    obj.removeEventListener('error', onerror);
    obj.removeEventListener('abort', onerror);
  }
  obj.addEventListener('complete', onsuccess);
  obj.addEventListener('success', onsuccess);
  obj.addEventListener('error', onerror);
  obj.addEventListener('abort', onerror);
};

IDBHelper.iterate = function(cursorRequest, eachCallback, doneCallback, errorCallback) {
  var oldCursorContinue;

  function cursorContinue() {
    this._continuing = true;
    return oldCursorContinue.call(this);
  }

  cursorRequest.onsuccess = function() {
    var cursor = cursorRequest.result;

    if (!cursor) {
      if (doneCallback) {
        doneCallback();
      }
      return;
    }

    if (cursor.continue != cursorContinue) {
      oldCursorContinue = cursor.continue;
      cursor.continue = cursorContinue;
    }

    eachCallback(cursor);

    if (!cursor._continuing) {
      if (doneCallback) {
        doneCallback();
      }
    }
  };

  cursorRequest.onerror = function() {
    if (errorCallback) {
      errorCallback(cursorRequest.error);
    }
  };
};

var IDBHelperProto = IDBHelper.prototype;

IDBHelperProto.transaction = function(stores, callback, opts) {
  opts = opts || {};

  return this.ready.then(function(db) {
    var mode = opts.mode || 'readonly';

    var tx = db.transaction(stores, mode);
    callback(tx, db);
    return IDBHelper.promisify(tx);
  });
};

module.exports = IDBHelper;
},{}],5:[function(require,module,exports){
var caches = require('../libs/caches');

self.oninstall = function(event) {
  event.waitUntil(Promise.all([
    caches.open('trains-static-v13').then(function(cache) {
      return cache.addAll([
        '/trained-to-thrill/',
        '/trained-to-thrill/static/css/all.css',
        '/trained-to-thrill/static/js/page.js',
        '/trained-to-thrill/static/imgs/logo.svg',
        '/trained-to-thrill/static/imgs/icon.png'
      ]);
    })
  ]));
};

var expectedCaches = [
  'trains-static-v13',
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
  else if (requestURL.hostname == 'trained-to-thrill-proxy.appspot.com') {
    event.respondWith(flickrImageResponse(event.request));
  }
  else {
    event.respondWith(
      caches.match(event.request, {
        ignoreVary: true
      }).then(function(response) {
        if (response) {
          return response;
        }
      })
    );
  }
};

function flickrAPIResponse(request) {
  if (request.headers.get('Accept') == 'x-cache/only') {
    return caches.match(request);
  }
  else {
    return fetch(request.url).then(function(response) {
      return caches.open('trains-data').then(function(cache) {
        // clean up the image cache
        Promise.all([
          response.clone().json(),
          caches.open('trains-imgs')
        ]).then(function(results) {
          var data = results[0];
          var imgCache = results[1];

          var imgURLs = data.photos.photo.map(function(photo) {
            return 'https://trained-to-thrill-proxy.appspot.com/farm' + photo.farm + '.staticflickr.com/' + photo.server + '/' + photo.id + '_' + photo.secret + '_c.jpg';
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

    return fetch(request.url).then(function(response) {
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

},{"../libs/caches":3}]},{},[5])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvdHJhaW5lZC10by10aHJpbGwvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi90cmFpbmVkLXRvLXRocmlsbC93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvdHJhaW5lZC10by10aHJpbGwvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvdHJhaW5lZC10by10aHJpbGwvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi90cmFpbmVkLXRvLXRocmlsbC93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvaWRiaGVscGVyLmpzIiwiL1VzZXJzL2pha2VhcmNoaWJhbGQvZGV2L3RyYWluZWQtdG8tdGhyaWxsL3d3dy9zdGF0aWMvanMtdW5taW4vc3cvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDemFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcblxuZnVuY3Rpb24gQ2FjaGUoKSB7XG4gIHRoaXMuX25hbWUgPSAnJztcbiAgdGhpcy5fb3JpZ2luID0gJyc7XG59XG5cbnZhciBDYWNoZVByb3RvID0gQ2FjaGUucHJvdG90eXBlO1xuXG5DYWNoZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGwodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVQcm90by5hZGRBbGwgPSBmdW5jdGlvbihyZXF1ZXN0cykge1xuICBQcm9taXNlLmFsbChcbiAgICByZXF1ZXN0cy5tYXAoZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgcmV0dXJuIGZldGNoKHJlcXVlc3QpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZXMpIHtcbiAgICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXNwb25zZXMubWFwKGZ1bmN0aW9uKHJlc3BvbnNlLCBpKSB7XG4gICAgICByZXR1cm4gW3JlcXVlc3RzW2ldLCByZXNwb25zZV07XG4gICAgfSkpO1xuICB9LmJpbmQodGhpcykpO1xufTtcblxuQ2FjaGVQcm90by5hZGQgPSBmdW5jdGlvbihyZXF1ZXN0KSB7XG4gIHJldHVybiB0aGlzLmFkZEFsbChbcmVxdWVzdF0pO1xufTtcblxuQ2FjaGVQcm90by5wdXQgPSBmdW5jdGlvbihyZXF1ZXN0LCByZXNwb25zZSkge1xuICBpZiAoIShyZXNwb25zZSBpbnN0YW5jZW9mIFJlc3BvbnNlKSkge1xuICAgIHRocm93IFR5cGVFcnJvcihcIkluY29ycmVjdCByZXNwb25zZSB0eXBlXCIpO1xuICB9XG5cbiAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgW1tyZXF1ZXN0LCByZXNwb25zZV1dKTtcbn07XG5cbkNhY2hlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZSh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLmtleXMgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgaWYgKHJlcXVlc3QpIHtcbiAgICByZXR1cm4gY2FjaGVEQi5tYXRjaEFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbiAgfVxuICBlbHNlIHtcbiAgICByZXR1cm4gY2FjaGVEQi5hbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUpO1xuICB9XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IENhY2hlO1xuIiwidmFyIElEQkhlbHBlciA9IHJlcXVpcmUoJy4vaWRiaGVscGVyJyk7XG5cbmZ1bmN0aW9uIG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS50b0xvd2VyQ2FzZSgpLnNwbGl0KCcsJyk7XG4gIHZhciB2YXJ5SGVhZGVyO1xuICB2YXIgcmVxdWVzdEhlYWRlcnMgPSB7fTtcblxuICBmb3IgKHZhciBoZWFkZXIgb2YgcmVxdWVzdC5oZWFkZXJzKSB7XG4gICAgcmVxdWVzdEhlYWRlcnNbaGVhZGVyWzBdLnRvTG93ZXJDYXNlKCldID0gaGVhZGVyWzFdO1xuICB9XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0SGVhZGVyc1t2YXJ5SGVhZGVyXSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVmFyeUlEKGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICB2YXIgaWQgPSAnJztcblxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gfHwgJycpICsgJ1xcbic7XG4gIH1cblxuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcbiAgdmFyIHJldHVyblZhbCA9IHt9O1xuXG4gIGZvciAodmFyIGhlYWRlciBvZiBoZWFkZXJzKSB7XG4gICAgcmV0dXJuVmFsW2hlYWRlclswXS50b0xvd2VyQ2FzZSgpXSA9IGhlYWRlclsxXTtcbiAgfVxuXG4gIHJldHVybiByZXR1cm5WYWw7XG59XG5cbmZ1bmN0aW9uIGVudHJ5VG9SZXNwb25zZShlbnRyeSkge1xuICB2YXIgZW50cnlSZXNwb25zZSA9IGVudHJ5LnJlc3BvbnNlO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKGVudHJ5UmVzcG9uc2UuYm9keSwge1xuICAgIHN0YXR1czogZW50cnlSZXNwb25zZS5zdGF0dXMsXG4gICAgc3RhdHVzVGV4dDogZW50cnlSZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgIGhlYWRlcnM6IGVudHJ5UmVzcG9uc2UuaGVhZGVyc1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCBib2R5KSB7XG4gIHJldHVybiB7XG4gICAgYm9keTogYm9keSxcbiAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlc3BvbnNlLmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudHJ5VG9SZXF1ZXN0KGVudHJ5KSB7XG4gIHZhciBlbnRyeVJlcXVlc3QgPSBlbnRyeS5yZXF1ZXN0O1xuICByZXR1cm4gbmV3IFJlcXVlc3QoZW50cnlSZXF1ZXN0LnVybCwge1xuICAgIG1vZGU6IGVudHJ5UmVxdWVzdC5tb2RlLFxuICAgIGhlYWRlcnM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzLFxuICAgIGNyZWRlbnRpYWxzOiBlbnRyeVJlcXVlc3QuaGVhZGVyc1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVxdWVzdFRvRW50cnkocmVxdWVzdCkge1xuICByZXR1cm4ge1xuICAgIHVybDogcmVxdWVzdC51cmwsXG4gICAgbW9kZTogcmVxdWVzdC5tb2RlLFxuICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmNyZWRlbnRpYWxzLFxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KSB7XG4gIGlmICghKHJlcXVlc3QgaW5zdGFuY2VvZiBSZXF1ZXN0KSkge1xuICAgIHJlcXVlc3QgPSBuZXcgUmVxdWVzdChyZXF1ZXN0KTtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZnVuY3Rpb24gQ2FjaGVEQigpIHtcbiAgdGhpcy5kYiA9IG5ldyBJREJIZWxwZXIoJ2NhY2hlLXBvbHlmaWxsJywgMSwgZnVuY3Rpb24oZGIsIG9sZFZlcnNpb24pIHtcbiAgICBzd2l0Y2ggKG9sZFZlcnNpb24pIHtcbiAgICAgIGNhc2UgMDpcbiAgICAgICAgdmFyIG5hbWVzU3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZSgnY2FjaGVOYW1lcycsIHtcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICduYW1lJ11cbiAgICAgICAgfSk7XG4gICAgICAgIG5hbWVzU3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbicsIFsnb3JpZ2luJywgJ2FkZGVkJ10pO1xuXG4gICAgICAgIHZhciBlbnRyeVN0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycsIHtcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAndmFyeUlEJ11cbiAgICAgICAgfSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAnYWRkZWQnXSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUtdXJsTm9TZWFyY2gnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdFVybE5vU2VhcmNoJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICdhZGRlZCddKTtcbiAgICB9XG4gIH0pO1xufVxuXG52YXIgQ2FjaGVEQlByb3RvID0gQ2FjaGVEQi5wcm90b3R5cGU7XG5cbkNhY2hlREJQcm90by5fZWFjaENhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcbiAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5pbmRleCgnb3JpZ2luJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCAwXSwgW29yaWdpbiwgSW5maW5pdHldKSksXG4gICAgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2tcbiAgKTtcbn07XG5cbkNhY2hlREJQcm90by5fZWFjaE1hdGNoID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaywgcGFyYW1zKSB7XG4gIHBhcmFtcyA9IHBhcmFtcyB8fCB7fTtcblxuICB2YXIgaWdub3JlU2VhcmNoID0gQm9vbGVhbihwYXJhbXMuaWdub3JlU2VhcmNoKTtcbiAgdmFyIGlnbm9yZU1ldGhvZCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZU1ldGhvZCk7XG4gIHZhciBpZ25vcmVWYXJ5ID0gQm9vbGVhbihwYXJhbXMuaWdub3JlVmFyeSk7XG4gIHZhciBwcmVmaXhNYXRjaCA9IEJvb2xlYW4ocGFyYW1zLnByZWZpeE1hdGNoKTtcblxuICBpZiAoIWlnbm9yZU1ldGhvZCAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdHRVQnICYmXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0hFQUQnKSB7XG4gICAgLy8gd2Ugb25seSBzdG9yZSBHRVQgcmVzcG9uc2VzIGF0IHRoZSBtb21lbnQsIHNvIG5vIG1hdGNoXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcbiAgdmFyIHJhbmdlO1xuICB2YXIgaW5kZXg7XG4gIHZhciBpbmRleE5hbWUgPSAnb3JpZ2luLWNhY2hlTmFtZS11cmwnO1xuICB2YXIgdXJsVG9NYXRjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xuXG4gIHVybFRvTWF0Y2guaGFzaCA9ICcnO1xuXG4gIGlmIChpZ25vcmVTZWFyY2gpIHtcbiAgICB1cmxUb01hdGNoLnNlYXJjaCA9ICcnO1xuICAgIGluZGV4TmFtZSArPSAnTm9TZWFyY2gnO1xuICB9XG5cbiAgLy8gd29ya2luZyBhcm91bmQgY2hyb21lIGJ1Z3NcbiAgdXJsVG9NYXRjaCA9IHVybFRvTWF0Y2guaHJlZi5yZXBsYWNlKC8oXFw/fCN8XFw/IykkLywgJycpO1xuXG4gIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KGluZGV4TmFtZSk7XG5cbiAgaWYgKHByZWZpeE1hdGNoKSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2ggKyBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1NTM1KSwgSW5maW5pdHldKTtcbiAgfVxuICBlbHNlIHtcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgSW5maW5pdHldKTtcbiAgfVxuXG4gIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICB2YXIgdmFsdWUgPSBjdXJzb3IudmFsdWU7XG4gICAgXG4gICAgaWYgKGlnbm9yZVZhcnkgfHwgbWF0Y2hlc1ZhcnkocmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXNwb25zZSkpIHtcbiAgICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfSwgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5faGFzQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcbiAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcbiAgcmV0dXJuIElEQkhlbHBlci5jYWxsYmFja2lmeShzdG9yZS5nZXQoW29yaWdpbiwgY2FjaGVOYW1lXSksIGZ1bmN0aW9uKHZhbCkge1xuICAgIGRvbmVDYWxsYmFjayghIXZhbCk7XG4gIH0sIGVyckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5fZGVsZXRlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrLCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHJldHVyblZhbCA9IHRydWU7XG4gICAgY3Vyc29yLmRlbGV0ZSgpO1xuICB9LCBmdW5jdGlvbigpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2socmV0dXJuVmFsKTtcbiAgICB9XG4gIH0sIGVyckNhbGxiYWNrLCBwYXJhbXMpO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xuICAgIHZhciBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSk7XG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXNwb25zZSk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWNyb3NzQ2FjaGVzID0gZnVuY3Rpb24ob3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICB2YXIgY2FjaGVOYW1lID0gY3Vyc29yLnZhbHVlLm5hbWU7XG5cbiAgICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcbiAgICAgICAgLy8gd2UncmUgZG9uZVxuICAgICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG5cbiAgICAgIGlmICghbWF0Y2gpIHsgLy8gY29udGludWUgaWYgbm8gbWF0Y2hcbiAgICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgICB9XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmNhY2hlTmFtZXMgPSBmdW5jdGlvbihvcmlnaW4pIHtcbiAgdmFyIG5hbWVzID0gW107XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG5hbWVzLnB1c2goY3Vyc29yLnZhbHVlLm5hbWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBuYW1lcztcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgcmV0dXJuVmFsO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcywgZnVuY3Rpb24odikge1xuICAgICAgcmV0dXJuVmFsID0gdjtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm9wZW5DYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKHZhbCkge1xuICAgICAgaWYgKHZhbCkgeyByZXR1cm47IH1cbiAgICAgIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XG4gICAgICBzdG9yZS5hZGQoe1xuICAgICAgICBvcmlnaW46IG9yaWdpbixcbiAgICAgICAgbmFtZTogY2FjaGVOYW1lLFxuICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uaGFzQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICB2YXIgcmV0dXJuVmFsO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcbiAgICAgIHJldHVyblZhbCA9IHZhbDtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKHZhbCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZUNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5vbmx5KFtvcmlnaW4sIGNhY2hlTmFtZV0pKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBmdW5jdGlvbiBkZWwoY3Vyc29yKSB7XG4gICAgICByZXR1cm5WYWwgPSB0cnVlO1xuICAgICAgY3Vyc29yLmRlbGV0ZSgpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfVxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ucHV0ID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIGl0ZW1zKSB7XG4gIC8vIGl0ZW1zIGlzIFtbcmVxdWVzdCwgcmVzcG9uc2VdLCBbcmVxdWVzdCwgcmVzcG9uc2VdLCDigKZdXG4gIHZhciBpdGVtO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgaXRlbXMubGVuZ3RoOyBpKyspIHtcbiAgICBpdGVtc1tpXVswXSA9IGNhc3RUb1JlcXVlc3QoaXRlbXNbaV1bMF0pO1xuXG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignT25seSBHRVQgcmVxdWVzdHMgYXJlIHN1cHBvcnRlZCcpKTtcbiAgICB9XG5cbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xuICAgICAgaWYgKGl0ZW1zW2ldWzBdLnVybCA9PSBpdGVtc1tqXVswXS51cmwgJiYgbWF0Y2hlc1ZhcnkoaXRlbXNbal1bMF0sIGl0ZW1zW2ldWzBdLCBpdGVtc1tpXVsxXSkpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLmFsbChcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xuICAgICAgcmV0dXJuIGl0ZW1bMV0uYmxvYigpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZUJvZGllcykge1xuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24oaGFzQ2FjaGUpIHtcbiAgICAgICAgaWYgKCFoYXNDYWNoZSkge1xuICAgICAgICAgIHRocm93IEVycm9yKFwiQ2FjaGUgb2YgdGhhdCBuYW1lIGRvZXMgbm90IGV4aXN0XCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtLCBpKSB7XG4gICAgICAgICAgdmFyIHJlcXVlc3QgPSBpdGVtWzBdO1xuICAgICAgICAgIHZhciByZXNwb25zZSA9IGl0ZW1bMV07XG4gICAgICAgICAgdmFyIHJlcXVlc3RFbnRyeSA9IHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpO1xuICAgICAgICAgIHZhciByZXNwb25zZUVudHJ5ID0gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCByZXNwb25zZUJvZGllc1tpXSk7XG5cbiAgICAgICAgICB2YXIgcmVxdWVzdFVybE5vU2VhcmNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoLnNlYXJjaCA9ICcnO1xuICAgICAgICAgIC8vIHdvcmtpbmcgYXJvdW5kIENocm9tZSBidWdcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2ggPSByZXF1ZXN0VXJsTm9TZWFyY2guaHJlZi5yZXBsYWNlKC9cXD8kLywgJycpO1xuXG4gICAgICAgICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuYWRkKHtcbiAgICAgICAgICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogY2FjaGVOYW1lLFxuICAgICAgICAgICAgICByZXF1ZXN0OiByZXF1ZXN0RW50cnksXG4gICAgICAgICAgICAgIHJlc3BvbnNlOiByZXNwb25zZUVudHJ5LFxuICAgICAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2g6IHJlcXVlc3RVcmxOb1NlYXJjaCxcbiAgICAgICAgICAgICAgdmFyeUlEOiBjcmVhdGVWYXJ5SUQocmVxdWVzdEVudHJ5LCByZXNwb25zZUVudHJ5KSxcbiAgICAgICAgICAgICAgYWRkZWQ6IERhdGUubm93KClcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgICB9LmJpbmQodGhpcykpO1xuICAgIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlREIoKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xudmFyIENhY2hlID0gcmVxdWlyZSgnLi9jYWNoZScpO1xuXG5mdW5jdGlvbiBDYWNoZVN0b3JhZ2UoKSB7XG4gIHRoaXMuX29yaWdpbiA9IGxvY2F0aW9uLm9yaWdpbjtcbn1cblxudmFyIENhY2hlU3RvcmFnZVByb3RvID0gQ2FjaGVTdG9yYWdlLnByb3RvdHlwZTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uX3ZlbmRDYWNoZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XG4gIGNhY2hlLl9uYW1lID0gbmFtZTtcbiAgY2FjaGUuX29yaWdpbiA9IHRoaXMuX29yaWdpbjtcbiAgcmV0dXJuIGNhY2hlO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBY3Jvc3NDYWNoZXModGhpcy5fb3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uaGFzID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5oYXNDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ub3BlbiA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIub3BlbkNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5fdmVuZENhY2hlKG5hbWUpO1xuICB9LmJpbmQodGhpcykpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5kZWxldGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gY2FjaGVEQi5jYWNoZU5hbWVzKHRoaXMuX29yaWdpbik7XG59O1xuXG5zZWxmLmNhY2hlc1BvbHlmaWxsID0gbW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVTdG9yYWdlKCk7XG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XG4gIHZhciByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4obmFtZSwgdmVyc2lvbik7XG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xuICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gICAgdXBncmFkZUNhbGxiYWNrKHJlcXVlc3QucmVzdWx0LCBldmVudC5vbGRWZXJzaW9uKTtcbiAgfTtcbn1cblxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdpbmRleGVkREInIGluIHNlbGY7XG5cbklEQkhlbHBlci5wcm9taXNpZnkgPSBmdW5jdGlvbihvYmopIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIElEQkhlbHBlci5jYWxsYmFja2lmeShvYmosIHJlc29sdmUsIHJlamVjdCk7XG4gIH0pO1xufTtcblxuSURCSGVscGVyLmNhbGxiYWNraWZ5ID0gZnVuY3Rpb24ob2JqLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhvYmoucmVzdWx0KTtcbiAgICB9XG4gICAgdW5saXN0ZW4oKTtcbiAgfVxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XG4gICAgaWYgKGVyckNhbGxiYWNrKSB7XG4gICAgICBlcnJDYWxsYmFjayhvYmouZXJyb3IpO1xuICAgIH1cbiAgICB1bmxpc3RlbigpO1xuICB9XG4gIGZ1bmN0aW9uIHVubGlzdGVuKCkge1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3N1Y2Nlc3MnLCBvbnN1Y2Nlc3MpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xuICB9XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xufTtcblxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xuICB2YXIgb2xkQ3Vyc29yQ29udGludWU7XG5cbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XG4gICAgdGhpcy5fY29udGludWluZyA9IHRydWU7XG4gICAgcmV0dXJuIG9sZEN1cnNvckNvbnRpbnVlLmNhbGwodGhpcyk7XG4gIH1cblxuICBjdXJzb3JSZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcblxuICAgIGlmICghY3Vyc29yKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcbiAgICAgIG9sZEN1cnNvckNvbnRpbnVlID0gY3Vyc29yLmNvbnRpbnVlO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlID0gY3Vyc29yQ29udGludWU7XG4gICAgfVxuXG4gICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG5cbiAgICBpZiAoIWN1cnNvci5fY29udGludWluZykge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY3Vyc29yUmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcbiAgICAgIGVycm9yQ2FsbGJhY2soY3Vyc29yUmVxdWVzdC5lcnJvcik7XG4gICAgfVxuICB9O1xufTtcblxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcblxuSURCSGVscGVyUHJvdG8udHJhbnNhY3Rpb24gPSBmdW5jdGlvbihzdG9yZXMsIGNhbGxiYWNrLCBvcHRzKSB7XG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xuXG4gIHJldHVybiB0aGlzLnJlYWR5LnRoZW4oZnVuY3Rpb24oZGIpIHtcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xuXG4gICAgdmFyIHR4ID0gZGIudHJhbnNhY3Rpb24oc3RvcmVzLCBtb2RlKTtcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xuICAgIHJldHVybiBJREJIZWxwZXIucHJvbWlzaWZ5KHR4KTtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IElEQkhlbHBlcjsiLCJ2YXIgY2FjaGVzID0gcmVxdWlyZSgnLi4vbGlicy9jYWNoZXMnKTtcblxuc2VsZi5vbmluc3RhbGwgPSBmdW5jdGlvbihldmVudCkge1xuICBldmVudC53YWl0VW50aWwoUHJvbWlzZS5hbGwoW1xuICAgIGNhY2hlcy5vcGVuKCd0cmFpbnMtc3RhdGljLXYxMycpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBjYWNoZS5hZGRBbGwoW1xuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsLycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2Nzcy9hbGwuY3NzJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvanMvcGFnZS5qcycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2ltZ3MvbG9nby5zdmcnLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9pbWdzL2ljb24ucG5nJ1xuICAgICAgXSk7XG4gICAgfSlcbiAgXSkpO1xufTtcblxudmFyIGV4cGVjdGVkQ2FjaGVzID0gW1xuICAndHJhaW5zLXN0YXRpYy12MTMnLFxuICAndHJhaW5zLWltZ3MnLFxuICAndHJhaW5zLWRhdGEnXG5dO1xuXG5zZWxmLm9uYWN0aXZhdGUgPSBmdW5jdGlvbihldmVudCkge1xuICAvLyByZW1vdmUgY2FjaGVzIGJlZ2lubmluZyBcInRyYWlucy1cIiB0aGF0IGFyZW4ndCBpblxuICAvLyBleHBlY3RlZENhY2hlc1xuICBldmVudC53YWl0VW50aWwoXG4gICAgY2FjaGVzLmtleXMoKS50aGVuKGZ1bmN0aW9uKGNhY2hlTmFtZXMpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgY2FjaGVOYW1lcy5tYXAoZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gICAgICAgICAgaWYgKCEvXnRyYWlucy0vLnRlc3QoY2FjaGVOYW1lKSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZXhwZWN0ZWRDYWNoZXMuaW5kZXhPZihjYWNoZU5hbWUpID09IC0xKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZShjYWNoZU5hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfSlcbiAgKTtcbn07XG5cbnNlbGYub25mZXRjaCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gIHZhciByZXF1ZXN0VVJMID0gbmV3IFVSTChldmVudC5yZXF1ZXN0LnVybCk7XG5cbiAgaWYgKHJlcXVlc3RVUkwuaG9zdG5hbWUgPT0gJ2FwaS5mbGlja3IuY29tJykge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckFQSVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIGlmIChyZXF1ZXN0VVJMLmhvc3RuYW1lID09ICd0cmFpbmVkLXRvLXRocmlsbC1wcm94eS5hcHBzcG90LmNvbScpIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChmbGlja3JJbWFnZVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChcbiAgICAgIGNhY2hlcy5tYXRjaChldmVudC5yZXF1ZXN0LCB7XG4gICAgICAgIGlnbm9yZVZhcnk6IHRydWVcbiAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIGZsaWNrckFQSVJlc3BvbnNlKHJlcXVlc3QpIHtcbiAgaWYgKHJlcXVlc3QuaGVhZGVycy5nZXQoJ0FjY2VwdCcpID09ICd4LWNhY2hlL29ubHknKSB7XG4gICAgcmV0dXJuIGNhY2hlcy5tYXRjaChyZXF1ZXN0KTtcbiAgfVxuICBlbHNlIHtcbiAgICByZXR1cm4gZmV0Y2gocmVxdWVzdC51cmwpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIHJldHVybiBjYWNoZXMub3BlbigndHJhaW5zLWRhdGEnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIC8vIGNsZWFuIHVwIHRoZSBpbWFnZSBjYWNoZVxuICAgICAgICBQcm9taXNlLmFsbChbXG4gICAgICAgICAgcmVzcG9uc2UuY2xvbmUoKS5qc29uKCksXG4gICAgICAgICAgY2FjaGVzLm9wZW4oJ3RyYWlucy1pbWdzJylcbiAgICAgICAgXSkudGhlbihmdW5jdGlvbihyZXN1bHRzKSB7XG4gICAgICAgICAgdmFyIGRhdGEgPSByZXN1bHRzWzBdO1xuICAgICAgICAgIHZhciBpbWdDYWNoZSA9IHJlc3VsdHNbMV07XG5cbiAgICAgICAgICB2YXIgaW1nVVJMcyA9IGRhdGEucGhvdG9zLnBob3RvLm1hcChmdW5jdGlvbihwaG90bykge1xuICAgICAgICAgICAgcmV0dXJuICdodHRwczovL3RyYWluZWQtdG8tdGhyaWxsLXByb3h5LmFwcHNwb3QuY29tL2Zhcm0nICsgcGhvdG8uZmFybSArICcuc3RhdGljZmxpY2tyLmNvbS8nICsgcGhvdG8uc2VydmVyICsgJy8nICsgcGhvdG8uaWQgKyAnXycgKyBwaG90by5zZWNyZXQgKyAnX2MuanBnJztcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIC8vIGlmIGFuIGl0ZW0gaW4gdGhlIGNhY2hlICppc24ndCogaW4gaW1nVVJMcywgZGVsZXRlIGl0XG4gICAgICAgICAgaW1nQ2FjaGUua2V5cygpLnRoZW4oZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgICAgICAgICAgIHJlcXVlc3RzLmZvckVhY2goZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgICAgICAgICBpZiAoaW1nVVJMcy5pbmRleE9mKHJlcXVlc3QudXJsKSA9PSAtMSkge1xuICAgICAgICAgICAgICAgIGltZ0NhY2hlLmRlbGV0ZShyZXF1ZXN0KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZS5jbG9uZSgpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKFwiWWV5IGNhY2hlXCIpO1xuICAgICAgICB9LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICBjb25zb2xlLmxvZyhcIk5heSBjYWNoZVwiKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmxpY2tySW1hZ2VSZXNwb25zZShyZXF1ZXN0KSB7XG4gIHJldHVybiBjYWNoZXMubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH1cblxuICAgIHJldHVybiBmZXRjaChyZXF1ZXN0LnVybCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgY2FjaGVzLm9wZW4oJ3RyYWlucy1pbWdzJykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgICBjYWNoZS5wdXQocmVxdWVzdCwgcmVzcG9uc2UpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coJ3lleSBpbWcgY2FjaGUnKTtcbiAgICAgICAgfSwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coJ25heSBpbWcgY2FjaGUnKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHJlc3BvbnNlLmNsb25lKCk7XG4gICAgfSk7XG4gIH0pO1xufVxuIl19
