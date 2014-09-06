(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var cacheDB = require('./cachedb');

function castToRequest(request) {
  if (!(request instanceof Request)) {
    request = new Request(request);
  }
  return request;
}

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
  requests = requests.map(castToRequest);

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
  request = castToRequest(request);

  if (!(response instanceof Response)) {
    throw TypeError("Incorrect response type");
  }

  return cacheDB.put(this._origin, this._name, [[request, response]]);
};

CacheProto.delete = function(request, params) {
  request = castToRequest(request);
  return cacheDB.delete(this._origin, this._name, request, params);
};

CacheProto.keys = function(request, params) {
  if (request) {
    request = castToRequest(request);
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

  var varyHeaders = entryResponse.headers.vary.split(',');
  var varyHeader;

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    if (entryRequest.headers[varyHeader] != request.headers.get(varyHeader)) {
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

  var varyHeaders = entryResponse.headers.vary.split(',');
  var varyHeader;

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    id += varyHeader + ': ' + entryRequest.headers[varyHeader] + '\n';
  }

  return id;
}

function flattenHeaders(headers) {
  var returnVal = {};
  headers.forEach(function(val, key) {
    returnVal[key] = val;
  });

  // so XHR can read the result (we don't have access to this header)
  returnVal['Access-Control-Allow-Origin'] = location.origin;
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
      matches.push(cursor.key);
      cursor.continue();
    });
  }).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.matchAll = function(origin, cacheName, request, params) {
  var matches = [];
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

  return this.db.transaction('cacheEntries', function(tx) {
    this._delete(tx, origin, cacheName, request, params, function(v) {
      returnVal = v;
    });
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.createCache = function(origin, cacheName) {
  return this.db.transaction('cacheNames', function(tx) {
    var store = tx.objectStore('cacheNames');
    store.add({
      origin: origin,
      name: cacheName,
      added: Date.now()
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

  for (var i = 1; i < items.length; i++) {
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
      // item[1].body.asBlob() is the old API
      return item[1].asBlob ? item[1].asBlob() : item[1].body.asBlob();
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

CacheStorageProto.get = function(name) {
  return this.has(name).then(function(hasCache) {
    var cache;
    
    if (hasCache) {
      return this._vendCache(name);
    }
    else {
      return null;
    }
  }.bind(this));
};

CacheStorageProto.has = function(name) {
  return cacheDB.hasCache(this._origin, name);
};

CacheStorageProto.create = function(name) {
  return cacheDB.createCache(this._origin, name).then(function() {
    return this._vendCache(name);
  }.bind(this), function() {
    throw Error("Cache already exists");
  });
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(this._origin, name);
};

CacheStorageProto.keys = function() {
  return cacheDB.cacheNames(this._origin);
};

module.exports = new CacheStorage();

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
var version = 2;
var caches = require('../libs/caches');

self.oninstall = function(event) {
  event.waitUntil(Promise.all([
    caches.get('trains-static-v2').then(function(cache) {
      return cache || caches.create('trains-static-v2');
    }).then(function(cache) {
      return cache.addAll([
        '/trained-to-thrill/',
        '/trained-to-thrill/static/css/all.css',
        '/trained-to-thrill/static/js/page.js',
        '/trained-to-thrill/static/imgs/logo.svg',
        '/trained-to-thrill/static/imgs/icon.png'
      ]);
    }),
    caches.get('trains-imgs').then(function(cache) {
      return cache || caches.create('trains-imgs');
    })
  ]));
};

var expectedCaches = [
  'trains-static-v2',
  'trains-imgs'
];

self.onactivate = function(event) {
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
      caches.match(event.request).then(function(response) {
        if (response) {
          return response;
        }
        return new Response("No response");
      })
    );
  }
};

function flickrAPIResponse(request) {
  if (request.headers.get('Accept') == 'x-cache/only') {
    return caches.match(request).then(function(response) {
      if (response) {
        return response;
      }
      return new Response("No response");
    });
  }
  else {
    return fetch(request.url).then(function(response) {
      return caches.delete('trains-imgs').then(function() {
        return caches.create('trains-imgs');
      }).then(function(cache) {
        cache.put(request, response);
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
      caches.get('trains-imgs').then(function(cache) {
        cache.put(request, response);
      });

      return response;
    });
  });
}

},{"../libs/caches":3}]},{},[5])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvaWRiaGVscGVyLmpzIiwiL1VzZXJzL2pha2VhcmNoaWJhbGQvZGV2L2ZsaWNrci1vZmZsaW5lL3d3dy9zdGF0aWMvanMtdW5taW4vc3cvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN1lBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3REQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3Rocm93IG5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIil9dmFyIGY9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGYuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sZixmLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG5cbmZ1bmN0aW9uIGNhc3RUb1JlcXVlc3QocmVxdWVzdCkge1xuICBpZiAoIShyZXF1ZXN0IGluc3RhbmNlb2YgUmVxdWVzdCkpIHtcbiAgICByZXF1ZXN0ID0gbmV3IFJlcXVlc3QocmVxdWVzdCk7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmZ1bmN0aW9uIENhY2hlKCkge1xuICB0aGlzLl9uYW1lID0gJyc7XG4gIHRoaXMuX29yaWdpbiA9ICcnO1xufVxuXG52YXIgQ2FjaGVQcm90byA9IENhY2hlLnByb3RvdHlwZTtcblxuQ2FjaGVQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWxsKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkQWxsID0gZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgcmVxdWVzdHMgPSByZXF1ZXN0cy5tYXAoY2FzdFRvUmVxdWVzdCk7XG5cbiAgUHJvbWlzZS5hbGwoXG4gICAgcmVxdWVzdHMubWFwKGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0KTtcbiAgICB9KVxuICApLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VzKSB7XG4gICAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVzcG9uc2VzLm1hcChmdW5jdGlvbihyZXNwb25zZSwgaSkge1xuICAgICAgcmV0dXJuIFtyZXF1ZXN0c1tpXSwgcmVzcG9uc2VdO1xuICAgIH0pKTtcbiAgfS5iaW5kKHRoaXMpKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkID0gZnVuY3Rpb24ocmVxdWVzdCkge1xuICByZXR1cm4gdGhpcy5hZGRBbGwoW3JlcXVlc3RdKTtcbn07XG5cbkNhY2hlUHJvdG8ucHV0ID0gZnVuY3Rpb24ocmVxdWVzdCwgcmVzcG9uc2UpIHtcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgaWYgKCEocmVzcG9uc2UgaW5zdGFuY2VvZiBSZXNwb25zZSkpIHtcbiAgICB0aHJvdyBUeXBlRXJyb3IoXCJJbmNvcnJlY3QgcmVzcG9uc2UgdHlwZVwiKTtcbiAgfVxuXG4gIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIFtbcmVxdWVzdCwgcmVzcG9uc2VdXSk7XG59O1xuXG5DYWNoZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICBpZiAocmVxdWVzdCkge1xuICAgIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuICAgIHJldHVybiBjYWNoZURCLm1hdGNoQWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xuICB9XG4gIGVsc2Uge1xuICAgIHJldHVybiBjYWNoZURCLmFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSk7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQ2FjaGU7XG4iLCJ2YXIgSURCSGVscGVyID0gcmVxdWlyZSgnLi9pZGJoZWxwZXInKTtcblxuZnVuY3Rpb24gbWF0Y2hlc1ZhcnkocmVxdWVzdCwgZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnNwbGl0KCcsJyk7XG4gIHZhciB2YXJ5SGVhZGVyO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyeUhlYWRlcnMubGVuZ3RoOyBpKyspIHtcbiAgICB2YXJ5SGVhZGVyID0gdmFyeUhlYWRlcnNbaV0udHJpbSgpO1xuXG4gICAgaWYgKHZhcnlIZWFkZXIgPT0gJyonKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gIT0gcmVxdWVzdC5oZWFkZXJzLmdldCh2YXJ5SGVhZGVyKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVmFyeUlEKGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICB2YXIgaWQgPSAnJztcblxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkuc3BsaXQoJywnKTtcbiAgdmFyIHZhcnlIZWFkZXI7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlkICs9IHZhcnlIZWFkZXIgKyAnOiAnICsgZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gKyAnXFxuJztcbiAgfVxuXG4gIHJldHVybiBpZDtcbn1cblxuZnVuY3Rpb24gZmxhdHRlbkhlYWRlcnMoaGVhZGVycykge1xuICB2YXIgcmV0dXJuVmFsID0ge307XG4gIGhlYWRlcnMuZm9yRWFjaChmdW5jdGlvbih2YWwsIGtleSkge1xuICAgIHJldHVyblZhbFtrZXldID0gdmFsO1xuICB9KTtcblxuICAvLyBzbyBYSFIgY2FuIHJlYWQgdGhlIHJlc3VsdCAod2UgZG9uJ3QgaGF2ZSBhY2Nlc3MgdG8gdGhpcyBoZWFkZXIpXG4gIHJldHVyblZhbFsnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJ10gPSBsb2NhdGlvbi5vcmlnaW47XG4gIHJldHVybiByZXR1cm5WYWw7XG59XG5cbmZ1bmN0aW9uIGVudHJ5VG9SZXNwb25zZShlbnRyeSkge1xuICB2YXIgZW50cnlSZXNwb25zZSA9IGVudHJ5LnJlc3BvbnNlO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKGVudHJ5UmVzcG9uc2UuYm9keSwge1xuICAgIHN0YXR1czogZW50cnlSZXNwb25zZS5zdGF0dXMsXG4gICAgc3RhdHVzVGV4dDogZW50cnlSZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgIGhlYWRlcnM6IGVudHJ5UmVzcG9uc2UuaGVhZGVyc1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCBib2R5KSB7XG4gIHJldHVybiB7XG4gICAgYm9keTogYm9keSxcbiAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlc3BvbnNlLmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudHJ5VG9SZXF1ZXN0KGVudHJ5KSB7XG4gIHZhciBlbnRyeVJlcXVlc3QgPSBlbnRyeS5yZXF1ZXN0O1xuICByZXR1cm4gbmV3IFJlcXVlc3QoZW50cnlSZXF1ZXN0LnVybCwge1xuICAgIG1vZGU6IGVudHJ5UmVxdWVzdC5tb2RlLFxuICAgIGhlYWRlcnM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzLFxuICAgIGNyZWRlbnRpYWxzOiBlbnRyeVJlcXVlc3QuaGVhZGVyc1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVxdWVzdFRvRW50cnkocmVxdWVzdCkge1xuICByZXR1cm4ge1xuICAgIHVybDogcmVxdWVzdC51cmwsXG4gICAgbW9kZTogcmVxdWVzdC5tb2RlLFxuICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmNyZWRlbnRpYWxzLFxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gQ2FjaGVEQigpIHtcbiAgdGhpcy5kYiA9IG5ldyBJREJIZWxwZXIoJ2NhY2hlLXBvbHlmaWxsJywgMSwgZnVuY3Rpb24oZGIsIG9sZFZlcnNpb24pIHtcbiAgICBzd2l0Y2ggKG9sZFZlcnNpb24pIHtcbiAgICAgIGNhc2UgMDpcbiAgICAgICAgdmFyIG5hbWVzU3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZSgnY2FjaGVOYW1lcycsIHtcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICduYW1lJ11cbiAgICAgICAgfSk7XG4gICAgICAgIG5hbWVzU3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbicsIFsnb3JpZ2luJywgJ2FkZGVkJ10pO1xuXG4gICAgICAgIHZhciBlbnRyeVN0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycsIHtcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAndmFyeUlEJ11cbiAgICAgICAgfSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAnYWRkZWQnXSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUtdXJsTm9TZWFyY2gnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdFVybE5vU2VhcmNoJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICdhZGRlZCddKTtcbiAgICB9XG4gIH0pO1xufVxuXG52YXIgQ2FjaGVEQlByb3RvID0gQ2FjaGVEQi5wcm90b3R5cGU7XG5cbkNhY2hlREJQcm90by5fZWFjaENhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcbiAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5pbmRleCgnb3JpZ2luJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCAwXSwgW29yaWdpbiwgSW5maW5pdHldKSksXG4gICAgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2tcbiAgKTtcbn07XG5cbkNhY2hlREJQcm90by5fZWFjaE1hdGNoID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaywgcGFyYW1zKSB7XG4gIHBhcmFtcyA9IHBhcmFtcyB8fCB7fTtcblxuICB2YXIgaWdub3JlU2VhcmNoID0gQm9vbGVhbihwYXJhbXMuaWdub3JlU2VhcmNoKTtcbiAgdmFyIGlnbm9yZU1ldGhvZCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZU1ldGhvZCk7XG4gIHZhciBpZ25vcmVWYXJ5ID0gQm9vbGVhbihwYXJhbXMuaWdub3JlVmFyeSk7XG4gIHZhciBwcmVmaXhNYXRjaCA9IEJvb2xlYW4ocGFyYW1zLnByZWZpeE1hdGNoKTtcblxuICBpZiAoIWlnbm9yZU1ldGhvZCAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdHRVQnICYmXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0hFQUQnKSB7XG4gICAgLy8gd2Ugb25seSBzdG9yZSBHRVQgcmVzcG9uc2VzIGF0IHRoZSBtb21lbnQsIHNvIG5vIG1hdGNoXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcbiAgdmFyIHJhbmdlO1xuICB2YXIgaW5kZXg7XG4gIHZhciBpbmRleE5hbWUgPSAnb3JpZ2luLWNhY2hlTmFtZS11cmwnO1xuICB2YXIgdXJsVG9NYXRjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xuXG4gIHVybFRvTWF0Y2guaGFzaCA9ICcnO1xuXG4gIGlmIChpZ25vcmVTZWFyY2gpIHtcbiAgICB1cmxUb01hdGNoLnNlYXJjaCA9ICcnO1xuICAgIGluZGV4TmFtZSArPSAnTm9TZWFyY2gnO1xuICB9XG5cbiAgLy8gd29ya2luZyBhcm91bmQgY2hyb21lIGJ1Z3NcbiAgdXJsVG9NYXRjaCA9IHVybFRvTWF0Y2guaHJlZi5yZXBsYWNlKC8oXFw/fCN8XFw/IykkLywgJycpO1xuXG4gIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KGluZGV4TmFtZSk7XG5cbiAgaWYgKHByZWZpeE1hdGNoKSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2ggKyBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1NTM1KSwgSW5maW5pdHldKTtcbiAgfVxuICBlbHNlIHtcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgSW5maW5pdHldKTtcbiAgfVxuXG4gIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICB2YXIgdmFsdWUgPSBjdXJzb3IudmFsdWU7XG4gICAgXG4gICAgaWYgKGlnbm9yZVZhcnkgfHwgbWF0Y2hlc1ZhcnkocmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXNwb25zZSkpIHtcbiAgICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfSwgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5faGFzQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcbiAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcbiAgcmV0dXJuIElEQkhlbHBlci5jYWxsYmFja2lmeShzdG9yZS5nZXQoW29yaWdpbiwgY2FjaGVOYW1lXSksIGZ1bmN0aW9uKHZhbCkge1xuICAgIGRvbmVDYWxsYmFjayghIXZhbCk7XG4gIH0sIGVyckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5fZGVsZXRlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrLCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHJldHVyblZhbCA9IHRydWU7XG4gICAgY3Vyc29yLmRlbGV0ZSgpO1xuICB9LCBmdW5jdGlvbigpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2socmV0dXJuVmFsKTtcbiAgICB9XG4gIH0sIGVyckNhbGxiYWNrLCBwYXJhbXMpO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci5rZXkpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5hbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcbiAgICB2YXIgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKTtcblxuICAgIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9KTtcbiAgfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFsbCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXNwb25zZSk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFjcm9zc0NhY2hlcyA9IGZ1bmN0aW9uKG9yaWdpbiwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaDtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaENhY2hlKHR4LCBvcmlnaW4sIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgdmFyIGNhY2hlTmFtZSA9IGN1cnNvci52YWx1ZS5uYW1lO1xuXG4gICAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XG4gICAgICAgIC8vIHdlJ3JlIGRvbmVcbiAgICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuXG4gICAgICBpZiAoIW1hdGNoKSB7IC8vIGNvbnRpbnVlIGlmIG5vIG1hdGNoXG4gICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgfVxuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5jYWNoZU5hbWVzID0gZnVuY3Rpb24ob3JpZ2luKSB7XG4gIHZhciBuYW1lcyA9IFtdO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBuYW1lcy5wdXNoKGN1cnNvci52YWx1ZS5uYW1lKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbmFtZXM7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbDtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMsIGZ1bmN0aW9uKHYpIHtcbiAgICAgIHJldHVyblZhbCA9IHY7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5jcmVhdGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xuICAgIHN0b3JlLmFkZCh7XG4gICAgICBvcmlnaW46IG9yaWdpbixcbiAgICAgIG5hbWU6IGNhY2hlTmFtZSxcbiAgICAgIGFkZGVkOiBEYXRlLm5vdygpXG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uaGFzQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICB2YXIgcmV0dXJuVmFsO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcbiAgICAgIHJldHVyblZhbCA9IHZhbDtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKHZhbCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZUNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5vbmx5KFtvcmlnaW4sIGNhY2hlTmFtZV0pKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBmdW5jdGlvbiBkZWwoY3Vyc29yKSB7XG4gICAgICByZXR1cm5WYWwgPSB0cnVlO1xuICAgICAgY3Vyc29yLmRlbGV0ZSgpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfVxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ucHV0ID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIGl0ZW1zKSB7XG4gIC8vIGl0ZW1zIGlzIFtbcmVxdWVzdCwgcmVzcG9uc2VdLCBbcmVxdWVzdCwgcmVzcG9uc2VdLCDigKZdXG4gIHZhciBpdGVtO1xuXG4gIGZvciAodmFyIGkgPSAxOyBpIDwgaXRlbXMubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoaXRlbXNbaV1bMF0ubWV0aG9kICE9ICdHRVQnKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdPbmx5IEdFVCByZXF1ZXN0cyBhcmUgc3VwcG9ydGVkJykpO1xuICAgIH1cblxuICAgIC8vIGVuc3VyZSBlYWNoIGVudHJ5IGJlaW5nIHB1dCB3b24ndCBvdmVyd3JpdGUgZWFybGllciBlbnRyaWVzIGJlaW5nIHB1dFxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgaTsgaisrKSB7XG4gICAgICBpZiAoaXRlbXNbaV1bMF0udXJsID09IGl0ZW1zW2pdWzBdLnVybCAmJiBtYXRjaGVzVmFyeShpdGVtc1tqXVswXSwgaXRlbXNbaV1bMF0sIGl0ZW1zW2ldWzFdKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdQdXRzIHdvdWxkIG92ZXJ3cml0ZSBlYWNob3RoZXInKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIGl0ZW1zLm1hcChmdW5jdGlvbihpdGVtKSB7XG4gICAgICAvLyBpdGVtWzFdLmJvZHkuYXNCbG9iKCkgaXMgdGhlIG9sZCBBUElcbiAgICAgIHJldHVybiBpdGVtWzFdLmFzQmxvYiA/IGl0ZW1bMV0uYXNCbG9iKCkgOiBpdGVtWzFdLmJvZHkuYXNCbG9iKCk7XG4gICAgfSlcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlQm9kaWVzKSB7XG4gICAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbihoYXNDYWNoZSkge1xuICAgICAgICBpZiAoIWhhc0NhY2hlKSB7XG4gICAgICAgICAgdGhyb3cgRXJyb3IoXCJDYWNoZSBvZiB0aGF0IG5hbWUgZG9lcyBub3QgZXhpc3RcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpdGVtcy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0sIGkpIHtcbiAgICAgICAgICB2YXIgcmVxdWVzdCA9IGl0ZW1bMF07XG4gICAgICAgICAgdmFyIHJlc3BvbnNlID0gaXRlbVsxXTtcbiAgICAgICAgICB2YXIgcmVxdWVzdEVudHJ5ID0gcmVxdWVzdFRvRW50cnkocmVxdWVzdCk7XG4gICAgICAgICAgdmFyIHJlc3BvbnNlRW50cnkgPSByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIHJlc3BvbnNlQm9kaWVzW2ldKTtcblxuICAgICAgICAgIHZhciByZXF1ZXN0VXJsTm9TZWFyY2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2guc2VhcmNoID0gJyc7XG4gICAgICAgICAgLy8gd29ya2luZyBhcm91bmQgQ2hyb21lIGJ1Z1xuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaCA9IHJlcXVlc3RVcmxOb1NlYXJjaC5ocmVmLnJlcGxhY2UoL1xcPyQvLCAnJyk7XG5cbiAgICAgICAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5hZGQoe1xuICAgICAgICAgICAgICBvcmlnaW46IG9yaWdpbixcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiBjYWNoZU5hbWUsXG4gICAgICAgICAgICAgIHJlcXVlc3Q6IHJlcXVlc3RFbnRyeSxcbiAgICAgICAgICAgICAgcmVzcG9uc2U6IHJlc3BvbnNlRW50cnksXG4gICAgICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaDogcmVxdWVzdFVybE5vU2VhcmNoLFxuICAgICAgICAgICAgICB2YXJ5SUQ6IGNyZWF0ZVZhcnlJRChyZXF1ZXN0RW50cnksIHJlc3BvbnNlRW50cnkpLFxuICAgICAgICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgfS5iaW5kKHRoaXMpKTtcbiAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVEQigpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG52YXIgQ2FjaGUgPSByZXF1aXJlKCcuL2NhY2hlJyk7XG5cbmZ1bmN0aW9uIENhY2hlU3RvcmFnZSgpIHtcbiAgdGhpcy5fb3JpZ2luID0gbG9jYXRpb24ub3JpZ2luO1xufVxuXG52YXIgQ2FjaGVTdG9yYWdlUHJvdG8gPSBDYWNoZVN0b3JhZ2UucHJvdG90eXBlO1xuXG5DYWNoZVN0b3JhZ2VQcm90by5fdmVuZENhY2hlID0gZnVuY3Rpb24obmFtZSkge1xuICB2YXIgY2FjaGUgPSBuZXcgQ2FjaGUoKTtcbiAgY2FjaGUuX25hbWUgPSBuYW1lO1xuICBjYWNoZS5fb3JpZ2luID0gdGhpcy5fb3JpZ2luO1xuICByZXR1cm4gY2FjaGU7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFjcm9zc0NhY2hlcyh0aGlzLl9vcmlnaW4sIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5nZXQgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiB0aGlzLmhhcyhuYW1lKS50aGVuKGZ1bmN0aW9uKGhhc0NhY2hlKSB7XG4gICAgdmFyIGNhY2hlO1xuICAgIFxuICAgIGlmIChoYXNDYWNoZSkge1xuICAgICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5oYXMgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmhhc0NhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5jcmVhdGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmNyZWF0ZUNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5fdmVuZENhY2hlKG5hbWUpO1xuICB9LmJpbmQodGhpcyksIGZ1bmN0aW9uKCkge1xuICAgIHRocm93IEVycm9yKFwiQ2FjaGUgYWxyZWFkeSBleGlzdHNcIik7XG4gIH0pO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5kZWxldGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gY2FjaGVEQi5jYWNoZU5hbWVzKHRoaXMuX29yaWdpbik7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IG5ldyBDYWNoZVN0b3JhZ2UoKTtcbiIsImZ1bmN0aW9uIElEQkhlbHBlcihuYW1lLCB2ZXJzaW9uLCB1cGdyYWRlQ2FsbGJhY2spIHtcbiAgdmFyIHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihuYW1lLCB2ZXJzaW9uKTtcbiAgdGhpcy5yZWFkeSA9IElEQkhlbHBlci5wcm9taXNpZnkocmVxdWVzdCk7XG4gIHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gZnVuY3Rpb24oZXZlbnQpIHtcbiAgICB1cGdyYWRlQ2FsbGJhY2socmVxdWVzdC5yZXN1bHQsIGV2ZW50Lm9sZFZlcnNpb24pO1xuICB9O1xufVxuXG5JREJIZWxwZXIuc3VwcG9ydGVkID0gJ2luZGV4ZWREQicgaW4gc2VsZjtcblxuSURCSGVscGVyLnByb21pc2lmeSA9IGZ1bmN0aW9uKG9iaikge1xuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgSURCSGVscGVyLmNhbGxiYWNraWZ5KG9iaiwgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgfSk7XG59O1xuXG5JREJIZWxwZXIuY2FsbGJhY2tpZnkgPSBmdW5jdGlvbihvYmosIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcbiAgZnVuY3Rpb24gb25zdWNjZXNzKGV2ZW50KSB7XG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgZG9uZUNhbGxiYWNrKG9iai5yZXN1bHQpO1xuICAgIH1cbiAgICB1bmxpc3RlbigpO1xuICB9XG4gIGZ1bmN0aW9uIG9uZXJyb3IoZXZlbnQpIHtcbiAgICBpZiAoZXJyQ2FsbGJhY2spIHtcbiAgICAgIGVyckNhbGxiYWNrKG9iai5lcnJvcik7XG4gICAgfVxuICAgIHVubGlzdGVuKCk7XG4gIH1cbiAgZnVuY3Rpb24gdW5saXN0ZW4oKSB7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NvbXBsZXRlJywgb25zdWNjZXNzKTtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignc3VjY2VzcycsIG9uc3VjY2Vzcyk7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0Jywgb25lcnJvcik7XG4gIH1cbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ2NvbXBsZXRlJywgb25zdWNjZXNzKTtcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Y2Nlc3MnLCBvbnN1Y2Nlc3MpO1xuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignZXJyb3InLCBvbmVycm9yKTtcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0Jywgb25lcnJvcik7XG59O1xuXG5JREJIZWxwZXIuaXRlcmF0ZSA9IGZ1bmN0aW9uKGN1cnNvclJlcXVlc3QsIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XG4gIHZhciBvbGRDdXJzb3JDb250aW51ZTtcblxuICBmdW5jdGlvbiBjdXJzb3JDb250aW51ZSgpIHtcbiAgICB0aGlzLl9jb250aW51aW5nID0gdHJ1ZTtcbiAgICByZXR1cm4gb2xkQ3Vyc29yQ29udGludWUuY2FsbCh0aGlzKTtcbiAgfVxuXG4gIGN1cnNvclJlcXVlc3Qub25zdWNjZXNzID0gZnVuY3Rpb24oKSB7XG4gICAgdmFyIGN1cnNvciA9IGN1cnNvclJlcXVlc3QucmVzdWx0O1xuXG4gICAgaWYgKCFjdXJzb3IpIHtcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGN1cnNvci5jb250aW51ZSAhPSBjdXJzb3JDb250aW51ZSkge1xuICAgICAgb2xkQ3Vyc29yQ29udGludWUgPSBjdXJzb3IuY29udGludWU7XG4gICAgICBjdXJzb3IuY29udGludWUgPSBjdXJzb3JDb250aW51ZTtcbiAgICB9XG5cbiAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcblxuICAgIGlmICghY3Vyc29yLl9jb250aW51aW5nKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjdXJzb3JSZXF1ZXN0Lm9uZXJyb3IgPSBmdW5jdGlvbigpIHtcbiAgICBpZiAoZXJyb3JDYWxsYmFjaykge1xuICAgICAgZXJyb3JDYWxsYmFjayhjdXJzb3JSZXF1ZXN0LmVycm9yKTtcbiAgICB9XG4gIH07XG59O1xuXG52YXIgSURCSGVscGVyUHJvdG8gPSBJREJIZWxwZXIucHJvdG90eXBlO1xuXG5JREJIZWxwZXJQcm90by50cmFuc2FjdGlvbiA9IGZ1bmN0aW9uKHN0b3JlcywgY2FsbGJhY2ssIG9wdHMpIHtcbiAgb3B0cyA9IG9wdHMgfHwge307XG5cbiAgcmV0dXJuIHRoaXMucmVhZHkudGhlbihmdW5jdGlvbihkYikge1xuICAgIHZhciBtb2RlID0gb3B0cy5tb2RlIHx8ICdyZWFkb25seSc7XG5cbiAgICB2YXIgdHggPSBkYi50cmFuc2FjdGlvbihzdG9yZXMsIG1vZGUpO1xuICAgIGNhbGxiYWNrKHR4LCBkYik7XG4gICAgcmV0dXJuIElEQkhlbHBlci5wcm9taXNpZnkodHgpO1xuICB9KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gSURCSGVscGVyOyIsInZhciB2ZXJzaW9uID0gMjtcbnZhciBjYWNoZXMgPSByZXF1aXJlKCcuLi9saWJzL2NhY2hlcycpO1xuXG5zZWxmLm9uaW5zdGFsbCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gIGV2ZW50LndhaXRVbnRpbChQcm9taXNlLmFsbChbXG4gICAgY2FjaGVzLmdldCgndHJhaW5zLXN0YXRpYy12MicpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBjYWNoZSB8fCBjYWNoZXMuY3JlYXRlKCd0cmFpbnMtc3RhdGljLXYyJyk7XG4gICAgfSkudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgcmV0dXJuIGNhY2hlLmFkZEFsbChbXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvY3NzL2FsbC5jc3MnLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9qcy9wYWdlLmpzJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvaW1ncy9sb2dvLnN2ZycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2ltZ3MvaWNvbi5wbmcnXG4gICAgICBdKTtcbiAgICB9KSxcbiAgICBjYWNoZXMuZ2V0KCd0cmFpbnMtaW1ncycpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBjYWNoZSB8fCBjYWNoZXMuY3JlYXRlKCd0cmFpbnMtaW1ncycpO1xuICAgIH0pXG4gIF0pKTtcbn07XG5cbnZhciBleHBlY3RlZENhY2hlcyA9IFtcbiAgJ3RyYWlucy1zdGF0aWMtdjInLFxuICAndHJhaW5zLWltZ3MnXG5dO1xuXG5zZWxmLm9uYWN0aXZhdGUgPSBmdW5jdGlvbihldmVudCkge1xuICBldmVudC53YWl0VW50aWwoXG4gICAgY2FjaGVzLmtleXMoKS50aGVuKGZ1bmN0aW9uKGNhY2hlTmFtZXMpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgY2FjaGVOYW1lcy5tYXAoZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gICAgICAgICAgaWYgKCEvXnRyYWlucy0vLnRlc3QoY2FjaGVOYW1lKSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZXhwZWN0ZWRDYWNoZXMuaW5kZXhPZihjYWNoZU5hbWUpID09IC0xKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZShjYWNoZU5hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfSlcbiAgKTtcbn07XG5cbnNlbGYub25mZXRjaCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gIHZhciByZXF1ZXN0VVJMID0gbmV3IFVSTChldmVudC5yZXF1ZXN0LnVybCk7XG5cbiAgaWYgKHJlcXVlc3RVUkwuaG9zdG5hbWUgPT0gJ2FwaS5mbGlja3IuY29tJykge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckFQSVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIGlmICgvXFwuc3RhdGljZmxpY2tyXFwuY29tJC8udGVzdChyZXF1ZXN0VVJMLmhvc3RuYW1lKSkge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckltYWdlUmVzcG9uc2UoZXZlbnQucmVxdWVzdCkpO1xuICB9XG4gIGVsc2Uge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKFxuICAgICAgY2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoXCJObyByZXNwb25zZVwiKTtcbiAgICAgIH0pXG4gICAgKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gZmxpY2tyQVBJUmVzcG9uc2UocmVxdWVzdCkge1xuICBpZiAocmVxdWVzdC5oZWFkZXJzLmdldCgnQWNjZXB0JykgPT0gJ3gtY2FjaGUvb25seScpIHtcbiAgICByZXR1cm4gY2FjaGVzLm1hdGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKFwiTm8gcmVzcG9uc2VcIik7XG4gICAgfSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGZldGNoKHJlcXVlc3QudXJsKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZSgndHJhaW5zLWltZ3MnKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gY2FjaGVzLmNyZWF0ZSgndHJhaW5zLWltZ3MnKTtcbiAgICAgIH0pLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgICAgY2FjaGUucHV0KHJlcXVlc3QsIHJlc3BvbnNlKTtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmxpY2tySW1hZ2VSZXNwb25zZShyZXF1ZXN0KSB7XG4gIHJldHVybiBjYWNoZXMubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH1cblxuICAgIHJldHVybiBmZXRjaChyZXF1ZXN0LnVybCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgY2FjaGVzLmdldCgndHJhaW5zLWltZ3MnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH0pO1xuICB9KTtcbn1cbiJdfQ==
