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
      matches.push(cursor.value);
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
var caches = require('../libs/caches');

self.oninstall = function(event) {
  event.waitUntil(Promise.all([
    caches.get('trains-static-v6').then(function(cache) {
      return cache || caches.create('trains-static-v6');
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
  'trains-static-v6',
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
      return caches.get('trains-imgs').then(function(cache) {
        return cache || caches.create('trains-imgs');
      }).then(function(cache) {
        cache.keys().then(function(requests) {
          if (requests.length > 20) {
            return Promise.all(
              requests.slice(0, requests.length - 20).map(function(request) {
                cache.delete(request);
              })
            );
          }
        }).then(function() {
          cache.put(request, response);
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
      caches.get('trains-imgs').then(function(cache) {
        cache.put(request, response);
      });

      return response;
    });
  });
}

},{"../libs/caches":3}]},{},[5])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvaWRiaGVscGVyLmpzIiwiL1VzZXJzL2pha2VhcmNoaWJhbGQvZGV2L2ZsaWNrci1vZmZsaW5lL3d3dy9zdGF0aWMvanMtdW5taW4vc3cvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN1lBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3REQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcblxuZnVuY3Rpb24gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KSB7XG4gIGlmICghKHJlcXVlc3QgaW5zdGFuY2VvZiBSZXF1ZXN0KSkge1xuICAgIHJlcXVlc3QgPSBuZXcgUmVxdWVzdChyZXF1ZXN0KTtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZnVuY3Rpb24gQ2FjaGUoKSB7XG4gIHRoaXMuX25hbWUgPSAnJztcbiAgdGhpcy5fb3JpZ2luID0gJyc7XG59XG5cbnZhciBDYWNoZVByb3RvID0gQ2FjaGUucHJvdG90eXBlO1xuXG5DYWNoZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGwodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVQcm90by5hZGRBbGwgPSBmdW5jdGlvbihyZXF1ZXN0cykge1xuICByZXF1ZXN0cyA9IHJlcXVlc3RzLm1hcChjYXN0VG9SZXF1ZXN0KTtcblxuICBQcm9taXNlLmFsbChcbiAgICByZXF1ZXN0cy5tYXAoZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgcmV0dXJuIGZldGNoKHJlcXVlc3QpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZXMpIHtcbiAgICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXNwb25zZXMubWFwKGZ1bmN0aW9uKHJlc3BvbnNlLCBpKSB7XG4gICAgICByZXR1cm4gW3JlcXVlc3RzW2ldLCByZXNwb25zZV07XG4gICAgfSkpO1xuICB9LmJpbmQodGhpcykpO1xufTtcblxuQ2FjaGVQcm90by5hZGQgPSBmdW5jdGlvbihyZXF1ZXN0KSB7XG4gIHJldHVybiB0aGlzLmFkZEFsbChbcmVxdWVzdF0pO1xufTtcblxuQ2FjaGVQcm90by5wdXQgPSBmdW5jdGlvbihyZXF1ZXN0LCByZXNwb25zZSkge1xuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICBpZiAoIShyZXNwb25zZSBpbnN0YW5jZW9mIFJlc3BvbnNlKSkge1xuICAgIHRocm93IFR5cGVFcnJvcihcIkluY29ycmVjdCByZXNwb25zZSB0eXBlXCIpO1xuICB9XG5cbiAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgW1tyZXF1ZXN0LCByZXNwb25zZV1dKTtcbn07XG5cbkNhY2hlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuICByZXR1cm4gY2FjaGVEQi5kZWxldGUodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVQcm90by5rZXlzID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIGlmIChyZXF1ZXN0KSB7XG4gICAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG4gICAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGNhY2hlREIuYWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lKTtcbiAgfVxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBDYWNoZTtcbiIsInZhciBJREJIZWxwZXIgPSByZXF1aXJlKCcuL2lkYmhlbHBlcicpO1xuXG5mdW5jdGlvbiBtYXRjaGVzVmFyeShyZXF1ZXN0LCBlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkuc3BsaXQoJywnKTtcbiAgdmFyIHZhcnlIZWFkZXI7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0LmhlYWRlcnMuZ2V0KHZhcnlIZWFkZXIpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVWYXJ5SUQoZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XG4gIHZhciBpZCA9ICcnO1xuXG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcbiAgICByZXR1cm4gaWQ7XG4gIH1cblxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyBlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSArICdcXG4nO1xuICB9XG5cbiAgcmV0dXJuIGlkO1xufVxuXG5mdW5jdGlvbiBmbGF0dGVuSGVhZGVycyhoZWFkZXJzKSB7XG4gIHZhciByZXR1cm5WYWwgPSB7fTtcbiAgaGVhZGVycy5mb3JFYWNoKGZ1bmN0aW9uKHZhbCwga2V5KSB7XG4gICAgcmV0dXJuVmFsW2tleV0gPSB2YWw7XG4gIH0pO1xuXG4gIC8vIHNvIFhIUiBjYW4gcmVhZCB0aGUgcmVzdWx0ICh3ZSBkb24ndCBoYXZlIGFjY2VzcyB0byB0aGlzIGhlYWRlcilcbiAgcmV0dXJuVmFsWydBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nXSA9IGxvY2F0aW9uLm9yaWdpbjtcbiAgcmV0dXJuIHJldHVyblZhbDtcbn1cblxuZnVuY3Rpb24gZW50cnlUb1Jlc3BvbnNlKGVudHJ5KSB7XG4gIHZhciBlbnRyeVJlc3BvbnNlID0gZW50cnkucmVzcG9uc2U7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoZW50cnlSZXNwb25zZS5ib2R5LCB7XG4gICAgc3RhdHVzOiBlbnRyeVJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiBlbnRyeVJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZW50cnlSZXNwb25zZS5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIGJvZHkpIHtcbiAgcmV0dXJuIHtcbiAgICBib2R5OiBib2R5LFxuICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLFxuICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVzcG9uc2UuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW50cnlUb1JlcXVlc3QoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVxdWVzdCA9IGVudHJ5LnJlcXVlc3Q7XG4gIHJldHVybiBuZXcgUmVxdWVzdChlbnRyeVJlcXVlc3QudXJsLCB7XG4gICAgbW9kZTogZW50cnlSZXF1ZXN0Lm1vZGUsXG4gICAgaGVhZGVyczogZW50cnlSZXF1ZXN0LmhlYWRlcnMsXG4gICAgY3JlZGVudGlhbHM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KSB7XG4gIHJldHVybiB7XG4gICAgdXJsOiByZXF1ZXN0LnVybCxcbiAgICBtb2RlOiByZXF1ZXN0Lm1vZGUsXG4gICAgY3JlZGVudGlhbHM6IHJlcXVlc3QuY3JlZGVudGlhbHMsXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVxdWVzdC5oZWFkZXJzKVxuICB9O1xufVxuXG5mdW5jdGlvbiBDYWNoZURCKCkge1xuICB0aGlzLmRiID0gbmV3IElEQkhlbHBlcignY2FjaGUtcG9seWZpbGwnLCAxLCBmdW5jdGlvbihkYiwgb2xkVmVyc2lvbikge1xuICAgIHN3aXRjaCAob2xkVmVyc2lvbikge1xuICAgICAgY2FzZSAwOlxuICAgICAgICB2YXIgbmFtZXNTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJywge1xuICAgICAgICAgIGtleVBhdGg6IFsnb3JpZ2luJywgJ25hbWUnXVxuICAgICAgICB9KTtcbiAgICAgICAgbmFtZXNTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luJywgWydvcmlnaW4nLCAnYWRkZWQnXSk7XG5cbiAgICAgICAgdmFyIGVudHJ5U3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJywge1xuICAgICAgICAgIGtleVBhdGg6IFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICd2YXJ5SUQnXVxuICAgICAgICB9KTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZScsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdhZGRlZCddKTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmxOb1NlYXJjaCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0VXJsTm9TZWFyY2gnLCAnYWRkZWQnXSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUtdXJsJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ2FkZGVkJ10pO1xuICAgIH1cbiAgfSk7XG59XG5cbnZhciBDYWNoZURCUHJvdG8gPSBDYWNoZURCLnByb3RvdHlwZTtcblxuQ2FjaGVEQlByb3RvLl9lYWNoQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xuICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLmluZGV4KCdvcmlnaW4nKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIDBdLCBbb3JpZ2luLCBJbmZpbml0eV0pKSxcbiAgICBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFja1xuICApO1xufTtcblxuQ2FjaGVEQlByb3RvLl9lYWNoTWF0Y2ggPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrLCBwYXJhbXMpIHtcbiAgcGFyYW1zID0gcGFyYW1zIHx8IHt9O1xuXG4gIHZhciBpZ25vcmVTZWFyY2ggPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVTZWFyY2gpO1xuICB2YXIgaWdub3JlTWV0aG9kID0gQm9vbGVhbihwYXJhbXMuaWdub3JlTWV0aG9kKTtcbiAgdmFyIGlnbm9yZVZhcnkgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVWYXJ5KTtcbiAgdmFyIHByZWZpeE1hdGNoID0gQm9vbGVhbihwYXJhbXMucHJlZml4TWF0Y2gpO1xuXG4gIGlmICghaWdub3JlTWV0aG9kICYmXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0dFVCcgJiZcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnSEVBRCcpIHtcbiAgICAvLyB3ZSBvbmx5IHN0b3JlIEdFVCByZXNwb25zZXMgYXQgdGhlIG1vbWVudCwgc28gbm8gbWF0Y2hcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xuICB2YXIgcmFuZ2U7XG4gIHZhciBpbmRleDtcbiAgdmFyIGluZGV4TmFtZSA9ICdvcmlnaW4tY2FjaGVOYW1lLXVybCc7XG4gIHZhciB1cmxUb01hdGNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XG5cbiAgdXJsVG9NYXRjaC5oYXNoID0gJyc7XG5cbiAgaWYgKGlnbm9yZVNlYXJjaCkge1xuICAgIHVybFRvTWF0Y2guc2VhcmNoID0gJyc7XG4gICAgaW5kZXhOYW1lICs9ICdOb1NlYXJjaCc7XG4gIH1cblxuICAvLyB3b3JraW5nIGFyb3VuZCBjaHJvbWUgYnVnc1xuICB1cmxUb01hdGNoID0gdXJsVG9NYXRjaC5ocmVmLnJlcGxhY2UoLyhcXD98I3xcXD8jKSQvLCAnJyk7XG5cbiAgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoaW5kZXhOYW1lKTtcblxuICBpZiAocHJlZml4TWF0Y2gpIHtcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjU1MzUpLCBJbmZpbml0eV0pO1xuICB9XG4gIGVsc2Uge1xuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCBJbmZpbml0eV0pO1xuICB9XG5cbiAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihyYW5nZSksIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHZhciB2YWx1ZSA9IGN1cnNvci52YWx1ZTtcbiAgICBcbiAgICBpZiAoaWdub3JlVmFyeSB8fCBtYXRjaGVzVmFyeShyZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlc3BvbnNlKSkge1xuICAgICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfVxuICB9LCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spO1xufTtcblxuQ2FjaGVEQlByb3RvLl9oYXNDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xuICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xuICByZXR1cm4gSURCSGVscGVyLmNhbGxiYWNraWZ5KHN0b3JlLmdldChbb3JpZ2luLCBjYWNoZU5hbWVdKSwgZnVuY3Rpb24odmFsKSB7XG4gICAgZG9uZUNhbGxiYWNrKCEhdmFsKTtcbiAgfSwgZXJyQ2FsbGJhY2spO1xufTtcblxuQ2FjaGVEQlByb3RvLl9kZWxldGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2ssIHBhcmFtcykge1xuICB2YXIgcmV0dXJuVmFsID0gZmFsc2U7XG5cbiAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgcmV0dXJuVmFsID0gdHJ1ZTtcbiAgICBjdXJzb3IuZGVsZXRlKCk7XG4gIH0sIGZ1bmN0aW9uKCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhyZXR1cm5WYWwpO1xuICAgIH1cbiAgfSwgZXJyQ2FsbGJhY2ssIHBhcmFtcyk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xuICAgIHZhciBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSk7XG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVzcG9uc2UpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoID0gY3Vyc29yLnZhbHVlO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBY3Jvc3NDYWNoZXMgPSBmdW5jdGlvbihvcmlnaW4sIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIHZhciBjYWNoZU5hbWUgPSBjdXJzb3IudmFsdWUubmFtZTtcblxuICAgICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICAgIG1hdGNoID0gY3Vyc29yLnZhbHVlO1xuICAgICAgICAvLyB3ZSdyZSBkb25lXG4gICAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcblxuICAgICAgaWYgKCFtYXRjaCkgeyAvLyBjb250aW51ZSBpZiBubyBtYXRjaFxuICAgICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICAgIH1cbiAgICB9LmJpbmQodGhpcykpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uY2FjaGVOYW1lcyA9IGZ1bmN0aW9uKG9yaWdpbikge1xuICB2YXIgbmFtZXMgPSBbXTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaENhY2hlKHR4LCBvcmlnaW4sIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbmFtZXMucHVzaChjdXJzb3IudmFsdWUubmFtZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LmJpbmQodGhpcykpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG5hbWVzO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5kZWxldGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciByZXR1cm5WYWw7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zLCBmdW5jdGlvbih2KSB7XG4gICAgICByZXR1cm5WYWwgPSB2O1xuICAgIH0pO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uY3JlYXRlQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcbiAgICBzdG9yZS5hZGQoe1xuICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICBuYW1lOiBjYWNoZU5hbWUsXG4gICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgIH0pO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xufTtcblxuQ2FjaGVEQlByb3RvLmhhc0NhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbDtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24odmFsKSB7XG4gICAgICByZXR1cm5WYWwgPSB2YWw7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbih2YWwpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5kZWxldGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2Uub25seShbb3JpZ2luLCBjYWNoZU5hbWVdKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgZnVuY3Rpb24gZGVsKGN1cnNvcikge1xuICAgICAgcmV0dXJuVmFsID0gdHJ1ZTtcbiAgICAgIGN1cnNvci5kZWxldGUoKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLnB1dCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCBpdGVtcykge1xuICAvLyBpdGVtcyBpcyBbW3JlcXVlc3QsIHJlc3BvbnNlXSwgW3JlcXVlc3QsIHJlc3BvbnNlXSwg4oCmXVxuICB2YXIgaXRlbTtcblxuICBmb3IgKHZhciBpID0gMTsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignT25seSBHRVQgcmVxdWVzdHMgYXJlIHN1cHBvcnRlZCcpKTtcbiAgICB9XG5cbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xuICAgICAgaWYgKGl0ZW1zW2ldWzBdLnVybCA9PSBpdGVtc1tqXVswXS51cmwgJiYgbWF0Y2hlc1ZhcnkoaXRlbXNbal1bMF0sIGl0ZW1zW2ldWzBdLCBpdGVtc1tpXVsxXSkpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLmFsbChcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xuICAgICAgLy8gaXRlbVsxXS5ib2R5LmFzQmxvYigpIGlzIHRoZSBvbGQgQVBJXG4gICAgICByZXR1cm4gaXRlbVsxXS5hc0Jsb2IgPyBpdGVtWzFdLmFzQmxvYigpIDogaXRlbVsxXS5ib2R5LmFzQmxvYigpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZUJvZGllcykge1xuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24oaGFzQ2FjaGUpIHtcbiAgICAgICAgaWYgKCFoYXNDYWNoZSkge1xuICAgICAgICAgIHRocm93IEVycm9yKFwiQ2FjaGUgb2YgdGhhdCBuYW1lIGRvZXMgbm90IGV4aXN0XCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtLCBpKSB7XG4gICAgICAgICAgdmFyIHJlcXVlc3QgPSBpdGVtWzBdO1xuICAgICAgICAgIHZhciByZXNwb25zZSA9IGl0ZW1bMV07XG4gICAgICAgICAgdmFyIHJlcXVlc3RFbnRyeSA9IHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpO1xuICAgICAgICAgIHZhciByZXNwb25zZUVudHJ5ID0gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCByZXNwb25zZUJvZGllc1tpXSk7XG5cbiAgICAgICAgICB2YXIgcmVxdWVzdFVybE5vU2VhcmNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoLnNlYXJjaCA9ICcnO1xuICAgICAgICAgIC8vIHdvcmtpbmcgYXJvdW5kIENocm9tZSBidWdcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2ggPSByZXF1ZXN0VXJsTm9TZWFyY2guaHJlZi5yZXBsYWNlKC9cXD8kLywgJycpO1xuXG4gICAgICAgICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuYWRkKHtcbiAgICAgICAgICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogY2FjaGVOYW1lLFxuICAgICAgICAgICAgICByZXF1ZXN0OiByZXF1ZXN0RW50cnksXG4gICAgICAgICAgICAgIHJlc3BvbnNlOiByZXNwb25zZUVudHJ5LFxuICAgICAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2g6IHJlcXVlc3RVcmxOb1NlYXJjaCxcbiAgICAgICAgICAgICAgdmFyeUlEOiBjcmVhdGVWYXJ5SUQocmVxdWVzdEVudHJ5LCByZXNwb25zZUVudHJ5KSxcbiAgICAgICAgICAgICAgYWRkZWQ6IERhdGUubm93KClcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgICB9LmJpbmQodGhpcykpO1xuICAgIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlREIoKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xudmFyIENhY2hlID0gcmVxdWlyZSgnLi9jYWNoZScpO1xuXG5mdW5jdGlvbiBDYWNoZVN0b3JhZ2UoKSB7XG4gIHRoaXMuX29yaWdpbiA9IGxvY2F0aW9uLm9yaWdpbjtcbn1cblxudmFyIENhY2hlU3RvcmFnZVByb3RvID0gQ2FjaGVTdG9yYWdlLnByb3RvdHlwZTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uX3ZlbmRDYWNoZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XG4gIGNhY2hlLl9uYW1lID0gbmFtZTtcbiAgY2FjaGUuX29yaWdpbiA9IHRoaXMuX29yaWdpbjtcbiAgcmV0dXJuIGNhY2hlO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBY3Jvc3NDYWNoZXModGhpcy5fb3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uZ2V0ID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gdGhpcy5oYXMobmFtZSkudGhlbihmdW5jdGlvbihoYXNDYWNoZSkge1xuICAgIHZhciBjYWNoZTtcbiAgICBcbiAgICBpZiAoaGFzQ2FjaGUpIHtcbiAgICAgIHJldHVybiB0aGlzLl92ZW5kQ2FjaGUobmFtZSk7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9LmJpbmQodGhpcykpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uaGFzID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5oYXNDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uY3JlYXRlID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5jcmVhdGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcbiAgfS5iaW5kKHRoaXMpLCBmdW5jdGlvbigpIHtcbiAgICB0aHJvdyBFcnJvcihcIkNhY2hlIGFscmVhZHkgZXhpc3RzXCIpO1xuICB9KTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmtleXMgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIGNhY2hlREIuY2FjaGVOYW1lcyh0aGlzLl9vcmlnaW4pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVTdG9yYWdlKCk7XG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XG4gIHZhciByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4obmFtZSwgdmVyc2lvbik7XG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xuICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gICAgdXBncmFkZUNhbGxiYWNrKHJlcXVlc3QucmVzdWx0LCBldmVudC5vbGRWZXJzaW9uKTtcbiAgfTtcbn1cblxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdpbmRleGVkREInIGluIHNlbGY7XG5cbklEQkhlbHBlci5wcm9taXNpZnkgPSBmdW5jdGlvbihvYmopIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIElEQkhlbHBlci5jYWxsYmFja2lmeShvYmosIHJlc29sdmUsIHJlamVjdCk7XG4gIH0pO1xufTtcblxuSURCSGVscGVyLmNhbGxiYWNraWZ5ID0gZnVuY3Rpb24ob2JqLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhvYmoucmVzdWx0KTtcbiAgICB9XG4gICAgdW5saXN0ZW4oKTtcbiAgfVxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XG4gICAgaWYgKGVyckNhbGxiYWNrKSB7XG4gICAgICBlcnJDYWxsYmFjayhvYmouZXJyb3IpO1xuICAgIH1cbiAgICB1bmxpc3RlbigpO1xuICB9XG4gIGZ1bmN0aW9uIHVubGlzdGVuKCkge1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3N1Y2Nlc3MnLCBvbnN1Y2Nlc3MpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xuICB9XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xufTtcblxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xuICB2YXIgb2xkQ3Vyc29yQ29udGludWU7XG5cbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XG4gICAgdGhpcy5fY29udGludWluZyA9IHRydWU7XG4gICAgcmV0dXJuIG9sZEN1cnNvckNvbnRpbnVlLmNhbGwodGhpcyk7XG4gIH1cblxuICBjdXJzb3JSZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcblxuICAgIGlmICghY3Vyc29yKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcbiAgICAgIG9sZEN1cnNvckNvbnRpbnVlID0gY3Vyc29yLmNvbnRpbnVlO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlID0gY3Vyc29yQ29udGludWU7XG4gICAgfVxuXG4gICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG5cbiAgICBpZiAoIWN1cnNvci5fY29udGludWluZykge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY3Vyc29yUmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcbiAgICAgIGVycm9yQ2FsbGJhY2soY3Vyc29yUmVxdWVzdC5lcnJvcik7XG4gICAgfVxuICB9O1xufTtcblxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcblxuSURCSGVscGVyUHJvdG8udHJhbnNhY3Rpb24gPSBmdW5jdGlvbihzdG9yZXMsIGNhbGxiYWNrLCBvcHRzKSB7XG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xuXG4gIHJldHVybiB0aGlzLnJlYWR5LnRoZW4oZnVuY3Rpb24oZGIpIHtcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xuXG4gICAgdmFyIHR4ID0gZGIudHJhbnNhY3Rpb24oc3RvcmVzLCBtb2RlKTtcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xuICAgIHJldHVybiBJREJIZWxwZXIucHJvbWlzaWZ5KHR4KTtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IElEQkhlbHBlcjsiLCJ2YXIgY2FjaGVzID0gcmVxdWlyZSgnLi4vbGlicy9jYWNoZXMnKTtcblxuc2VsZi5vbmluc3RhbGwgPSBmdW5jdGlvbihldmVudCkge1xuICBldmVudC53YWl0VW50aWwoUHJvbWlzZS5hbGwoW1xuICAgIGNhY2hlcy5nZXQoJ3RyYWlucy1zdGF0aWMtdjYnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICByZXR1cm4gY2FjaGUgfHwgY2FjaGVzLmNyZWF0ZSgndHJhaW5zLXN0YXRpYy12NicpO1xuICAgIH0pLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBjYWNoZS5hZGRBbGwoW1xuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsLycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2Nzcy9hbGwuY3NzJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvanMvcGFnZS5qcycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2ltZ3MvbG9nby5zdmcnLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9pbWdzL2ljb24ucG5nJ1xuICAgICAgXSk7XG4gICAgfSksXG4gICAgY2FjaGVzLmdldCgndHJhaW5zLWltZ3MnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICByZXR1cm4gY2FjaGUgfHwgY2FjaGVzLmNyZWF0ZSgndHJhaW5zLWltZ3MnKTtcbiAgICB9KVxuICBdKSk7XG59O1xuXG52YXIgZXhwZWN0ZWRDYWNoZXMgPSBbXG4gICd0cmFpbnMtc3RhdGljLXY2JyxcbiAgJ3RyYWlucy1pbWdzJ1xuXTtcblxuc2VsZi5vbmFjdGl2YXRlID0gZnVuY3Rpb24oZXZlbnQpIHtcbiAgZXZlbnQud2FpdFVudGlsKFxuICAgIGNhY2hlcy5rZXlzKCkudGhlbihmdW5jdGlvbihjYWNoZU5hbWVzKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIGNhY2hlTmFtZXMubWFwKGZ1bmN0aW9uKGNhY2hlTmFtZSkge1xuICAgICAgICAgIGlmICghL150cmFpbnMtLy50ZXN0KGNhY2hlTmFtZSkpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGV4cGVjdGVkQ2FjaGVzLmluZGV4T2YoY2FjaGVOYW1lKSA9PSAtMSkge1xuICAgICAgICAgICAgcmV0dXJuIGNhY2hlcy5kZWxldGUoY2FjaGVOYW1lKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICApO1xuICAgIH0pXG4gICk7XG59O1xuXG5zZWxmLm9uZmV0Y2ggPSBmdW5jdGlvbihldmVudCkge1xuICB2YXIgcmVxdWVzdFVSTCA9IG5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpO1xuXG4gIGlmIChyZXF1ZXN0VVJMLmhvc3RuYW1lID09ICdhcGkuZmxpY2tyLmNvbScpIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChmbGlja3JBUElSZXNwb25zZShldmVudC5yZXF1ZXN0KSk7XG4gIH1cbiAgZWxzZSBpZiAoL1xcLnN0YXRpY2ZsaWNrclxcLmNvbSQvLnRlc3QocmVxdWVzdFVSTC5ob3N0bmFtZSkpIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChmbGlja3JJbWFnZVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChcbiAgICAgIGNhY2hlcy5tYXRjaChldmVudC5yZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKFwiTm8gcmVzcG9uc2VcIik7XG4gICAgICB9KVxuICAgICk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIGZsaWNrckFQSVJlc3BvbnNlKHJlcXVlc3QpIHtcbiAgaWYgKHJlcXVlc3QuaGVhZGVycy5nZXQoJ0FjY2VwdCcpID09ICd4LWNhY2hlL29ubHknKSB7XG4gICAgcmV0dXJuIGNhY2hlcy5tYXRjaChyZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcIk5vIHJlc3BvbnNlXCIpO1xuICAgIH0pO1xuICB9XG4gIGVsc2Uge1xuICAgIHJldHVybiBmZXRjaChyZXF1ZXN0LnVybCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgcmV0dXJuIGNhY2hlcy5nZXQoJ3RyYWlucy1pbWdzJykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgICByZXR1cm4gY2FjaGUgfHwgY2FjaGVzLmNyZWF0ZSgndHJhaW5zLWltZ3MnKTtcbiAgICAgIH0pLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgICAgY2FjaGUua2V5cygpLnRoZW4oZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgICAgICAgICBpZiAocmVxdWVzdHMubGVuZ3RoID4gMjApIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgICAgICAgcmVxdWVzdHMuc2xpY2UoMCwgcmVxdWVzdHMubGVuZ3RoIC0gMjApLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICAgICAgICAgICAgY2FjaGUuZGVsZXRlKHJlcXVlc3QpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgY2FjaGUucHV0KHJlcXVlc3QsIHJlc3BvbnNlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmbGlja3JJbWFnZVJlc3BvbnNlKHJlcXVlc3QpIHtcbiAgcmV0dXJuIGNhY2hlcy5tYXRjaChyZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZldGNoKHJlcXVlc3QudXJsKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICBjYWNoZXMuZ2V0KCd0cmFpbnMtaW1ncycpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgICAgY2FjaGUucHV0KHJlcXVlc3QsIHJlc3BvbnNlKTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgfSk7XG4gIH0pO1xufVxuIl19
