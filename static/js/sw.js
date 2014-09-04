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
  return cacheDB.cacheNames(this._origin).then(function(names) {
    return names.map(function(name) {
      return this._vendCache(name);
    }.bind(this));
  }.bind(this));
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
    caches.get('static-v1').then(function(cache) {
      return cache || caches.create('static-v1');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvaWRiaGVscGVyLmpzIiwiL1VzZXJzL2pha2VhcmNoaWJhbGQvZGV2L2ZsaWNrci1vZmZsaW5lL3d3dy9zdGF0aWMvanMtdW5taW4vc3cvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN1lBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpfXZhciBmPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChmLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGYsZi5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xuXG5mdW5jdGlvbiBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpIHtcbiAgaWYgKCEocmVxdWVzdCBpbnN0YW5jZW9mIFJlcXVlc3QpKSB7XG4gICAgcmVxdWVzdCA9IG5ldyBSZXF1ZXN0KHJlcXVlc3QpO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG5mdW5jdGlvbiBDYWNoZSgpIHtcbiAgdGhpcy5fbmFtZSA9ICcnO1xuICB0aGlzLl9vcmlnaW4gPSAnJztcbn1cblxudmFyIENhY2hlUHJvdG8gPSBDYWNoZS5wcm90b3R5cGU7XG5cbkNhY2hlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2godGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVQcm90by5tYXRjaEFsbCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFsbCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLmFkZEFsbCA9IGZ1bmN0aW9uKHJlcXVlc3RzKSB7XG4gIHJlcXVlc3RzID0gcmVxdWVzdHMubWFwKGNhc3RUb1JlcXVlc3QpO1xuXG4gIFByb21pc2UuYWxsKFxuICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICByZXR1cm4gZmV0Y2gocmVxdWVzdCk7XG4gICAgfSlcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xuICAgIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlc3BvbnNlcy5tYXAoZnVuY3Rpb24ocmVzcG9uc2UsIGkpIHtcbiAgICAgIHJldHVybiBbcmVxdWVzdHNbaV0sIHJlc3BvbnNlXTtcbiAgICB9KSk7XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVByb3RvLmFkZCA9IGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgcmV0dXJuIHRoaXMuYWRkQWxsKFtyZXF1ZXN0XSk7XG59O1xuXG5DYWNoZVByb3RvLnB1dCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlKSB7XG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgUmVzcG9uc2UpKSB7XG4gICAgdGhyb3cgVHlwZUVycm9yKFwiSW5jb3JyZWN0IHJlc3BvbnNlIHR5cGVcIik7XG4gIH1cblxuICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCBbW3JlcXVlc3QsIHJlc3BvbnNlXV0pO1xufTtcblxuQ2FjaGVQcm90by5kZWxldGUgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZSh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLmtleXMgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgaWYgKHJlcXVlc3QpIHtcbiAgICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcbiAgICByZXR1cm4gY2FjaGVEQi5tYXRjaEFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbiAgfVxuICBlbHNlIHtcbiAgICByZXR1cm4gY2FjaGVEQi5hbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUpO1xuICB9XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IENhY2hlO1xuIiwidmFyIElEQkhlbHBlciA9IHJlcXVpcmUoJy4vaWRiaGVscGVyJyk7XG5cbmZ1bmN0aW9uIG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKGVudHJ5UmVxdWVzdC5oZWFkZXJzW3ZhcnlIZWFkZXJdICE9IHJlcXVlc3QuaGVhZGVycy5nZXQodmFyeUhlYWRlcikpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVZhcnlJRChlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcbiAgdmFyIGlkID0gJyc7XG5cbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnNwbGl0KCcsJyk7XG4gIHZhciB2YXJ5SGVhZGVyO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyeUhlYWRlcnMubGVuZ3RoOyBpKyspIHtcbiAgICB2YXJ5SGVhZGVyID0gdmFyeUhlYWRlcnNbaV0udHJpbSgpO1xuXG4gICAgaWYgKHZhcnlIZWFkZXIgPT0gJyonKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZCArPSB2YXJ5SGVhZGVyICsgJzogJyArIGVudHJ5UmVxdWVzdC5oZWFkZXJzW3ZhcnlIZWFkZXJdICsgJ1xcbic7XG4gIH1cblxuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcbiAgdmFyIHJldHVyblZhbCA9IHt9O1xuICBoZWFkZXJzLmZvckVhY2goZnVuY3Rpb24odmFsLCBrZXkpIHtcbiAgICByZXR1cm5WYWxba2V5XSA9IHZhbDtcbiAgfSk7XG5cbiAgLy8gc28gWEhSIGNhbiByZWFkIHRoZSByZXN1bHQgKHdlIGRvbid0IGhhdmUgYWNjZXNzIHRvIHRoaXMgaGVhZGVyKVxuICByZXR1cm5WYWxbJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbiddID0gbG9jYXRpb24ub3JpZ2luO1xuICByZXR1cm4gcmV0dXJuVmFsO1xufVxuXG5mdW5jdGlvbiBlbnRyeVRvUmVzcG9uc2UoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVzcG9uc2UgPSBlbnRyeS5yZXNwb25zZTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShlbnRyeVJlc3BvbnNlLmJvZHksIHtcbiAgICBzdGF0dXM6IGVudHJ5UmVzcG9uc2Uuc3RhdHVzLFxuICAgIHN0YXR1c1RleHQ6IGVudHJ5UmVzcG9uc2Uuc3RhdHVzVGV4dCxcbiAgICBoZWFkZXJzOiBlbnRyeVJlc3BvbnNlLmhlYWRlcnNcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3BvbnNlVG9FbnRyeShyZXNwb25zZSwgYm9keSkge1xuICByZXR1cm4ge1xuICAgIGJvZHk6IGJvZHksXG4gICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXG4gICAgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCxcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXNwb25zZS5oZWFkZXJzKVxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnRyeVRvUmVxdWVzdChlbnRyeSkge1xuICB2YXIgZW50cnlSZXF1ZXN0ID0gZW50cnkucmVxdWVzdDtcbiAgcmV0dXJuIG5ldyBSZXF1ZXN0KGVudHJ5UmVxdWVzdC51cmwsIHtcbiAgICBtb2RlOiBlbnRyeVJlcXVlc3QubW9kZSxcbiAgICBoZWFkZXJzOiBlbnRyeVJlcXVlc3QuaGVhZGVycyxcbiAgICBjcmVkZW50aWFsczogZW50cnlSZXF1ZXN0LmhlYWRlcnNcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpIHtcbiAgcmV0dXJuIHtcbiAgICB1cmw6IHJlcXVlc3QudXJsLFxuICAgIG1vZGU6IHJlcXVlc3QubW9kZSxcbiAgICBjcmVkZW50aWFsczogcmVxdWVzdC5jcmVkZW50aWFscyxcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXF1ZXN0LmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIENhY2hlREIoKSB7XG4gIHRoaXMuZGIgPSBuZXcgSURCSGVscGVyKCdjYWNoZS1wb2x5ZmlsbCcsIDEsIGZ1bmN0aW9uKGRiLCBvbGRWZXJzaW9uKSB7XG4gICAgc3dpdGNoIChvbGRWZXJzaW9uKSB7XG4gICAgICBjYXNlIDA6XG4gICAgICAgIHZhciBuYW1lc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnbmFtZSddXG4gICAgICAgIH0pO1xuICAgICAgICBuYW1lc1N0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4nLCBbJ29yaWdpbicsICdhZGRlZCddKTtcblxuICAgICAgICB2YXIgZW50cnlTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ3ZhcnlJRCddXG4gICAgICAgIH0pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybE5vU2VhcmNoJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3RVcmxOb1NlYXJjaCcsICdhZGRlZCddKTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmwnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAnYWRkZWQnXSk7XG4gICAgfVxuICB9KTtcbn1cblxudmFyIENhY2hlREJQcm90byA9IENhY2hlREIucHJvdG90eXBlO1xuXG5DYWNoZURCUHJvdG8uX2VhY2hDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XG4gIElEQkhlbHBlci5pdGVyYXRlKFxuICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ29yaWdpbicpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgMF0sIFtvcmlnaW4sIEluZmluaXR5XSkpLFxuICAgIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrXG4gICk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2VhY2hNYXRjaCA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2ssIHBhcmFtcykge1xuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XG5cbiAgdmFyIGlnbm9yZVNlYXJjaCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVNlYXJjaCk7XG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xuICB2YXIgaWdub3JlVmFyeSA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVZhcnkpO1xuICB2YXIgcHJlZml4TWF0Y2ggPSBCb29sZWFuKHBhcmFtcy5wcmVmaXhNYXRjaCk7XG5cbiAgaWYgKCFpZ25vcmVNZXRob2QgJiZcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnR0VUJyAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xuICAgIC8vIHdlIG9ubHkgc3RvcmUgR0VUIHJlc3BvbnNlcyBhdCB0aGUgbW9tZW50LCBzbyBubyBtYXRjaFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gIHZhciByYW5nZTtcbiAgdmFyIGluZGV4O1xuICB2YXIgaW5kZXhOYW1lID0gJ29yaWdpbi1jYWNoZU5hbWUtdXJsJztcbiAgdmFyIHVybFRvTWF0Y2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcblxuICB1cmxUb01hdGNoLmhhc2ggPSAnJztcblxuICBpZiAoaWdub3JlU2VhcmNoKSB7XG4gICAgdXJsVG9NYXRjaC5zZWFyY2ggPSAnJztcbiAgICBpbmRleE5hbWUgKz0gJ05vU2VhcmNoJztcbiAgfVxuXG4gIC8vIHdvcmtpbmcgYXJvdW5kIGNocm9tZSBidWdzXG4gIHVybFRvTWF0Y2ggPSB1cmxUb01hdGNoLmhyZWYucmVwbGFjZSgvKFxcP3wjfFxcPyMpJC8sICcnKTtcblxuICBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleChpbmRleE5hbWUpO1xuXG4gIGlmIChwcmVmaXhNYXRjaCkge1xuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NTUzNSksIEluZmluaXR5XSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIEluZmluaXR5XSk7XG4gIH1cblxuICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKHJhbmdlKSwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgdmFyIHZhbHVlID0gY3Vyc29yLnZhbHVlO1xuICAgIFxuICAgIGlmIChpZ25vcmVWYXJ5IHx8IG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVzcG9uc2UpKSB7XG4gICAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9XG4gIH0sIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjayk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2hhc0NhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XG4gIHJldHVybiBJREJIZWxwZXIuY2FsbGJhY2tpZnkoc3RvcmUuZ2V0KFtvcmlnaW4sIGNhY2hlTmFtZV0pLCBmdW5jdGlvbih2YWwpIHtcbiAgICBkb25lQ2FsbGJhY2soISF2YWwpO1xuICB9LCBlcnJDYWxsYmFjayk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2RlbGV0ZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaywgcGFyYW1zKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICByZXR1cm5WYWwgPSB0cnVlO1xuICAgIGN1cnNvci5kZWxldGUoKTtcbiAgfSwgZnVuY3Rpb24oKSB7XG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgZG9uZUNhbGxiYWNrKHJldHVyblZhbCk7XG4gICAgfVxuICB9LCBlcnJDYWxsYmFjaywgcGFyYW1zKTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3Iua2V5KTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uYWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gICAgdmFyIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJyk7XG5cbiAgICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci5rZXkpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSk7XG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVzcG9uc2UpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoID0gY3Vyc29yLnZhbHVlO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBY3Jvc3NDYWNoZXMgPSBmdW5jdGlvbihvcmlnaW4sIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIHZhciBjYWNoZU5hbWUgPSBjdXJzb3IudmFsdWUubmFtZTtcblxuICAgICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICAgIG1hdGNoID0gY3Vyc29yLnZhbHVlO1xuICAgICAgICAvLyB3ZSdyZSBkb25lXG4gICAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcblxuICAgICAgaWYgKCFtYXRjaCkgeyAvLyBjb250aW51ZSBpZiBubyBtYXRjaFxuICAgICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICAgIH1cbiAgICB9LmJpbmQodGhpcykpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uY2FjaGVOYW1lcyA9IGZ1bmN0aW9uKG9yaWdpbikge1xuICB2YXIgbmFtZXMgPSBbXTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaENhY2hlKHR4LCBvcmlnaW4sIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbmFtZXMucHVzaChjdXJzb3IudmFsdWUubmFtZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LmJpbmQodGhpcykpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG5hbWVzO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5kZWxldGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciByZXR1cm5WYWw7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zLCBmdW5jdGlvbih2KSB7XG4gICAgICByZXR1cm5WYWwgPSB2O1xuICAgIH0pO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uY3JlYXRlQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcbiAgICBzdG9yZS5hZGQoe1xuICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICBuYW1lOiBjYWNoZU5hbWUsXG4gICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgIH0pO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xufTtcblxuQ2FjaGVEQlByb3RvLmhhc0NhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbDtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24odmFsKSB7XG4gICAgICByZXR1cm5WYWwgPSB2YWw7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbih2YWwpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5kZWxldGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2Uub25seShbb3JpZ2luLCBjYWNoZU5hbWVdKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgZnVuY3Rpb24gZGVsKGN1cnNvcikge1xuICAgICAgcmV0dXJuVmFsID0gdHJ1ZTtcbiAgICAgIGN1cnNvci5kZWxldGUoKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLnB1dCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCBpdGVtcykge1xuICAvLyBpdGVtcyBpcyBbW3JlcXVlc3QsIHJlc3BvbnNlXSwgW3JlcXVlc3QsIHJlc3BvbnNlXSwg4oCmXVxuICB2YXIgaXRlbTtcblxuICBmb3IgKHZhciBpID0gMTsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignT25seSBHRVQgcmVxdWVzdHMgYXJlIHN1cHBvcnRlZCcpKTtcbiAgICB9XG5cbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xuICAgICAgaWYgKGl0ZW1zW2ldWzBdLnVybCA9PSBpdGVtc1tqXVswXS51cmwgJiYgbWF0Y2hlc1ZhcnkoaXRlbXNbal1bMF0sIGl0ZW1zW2ldWzBdLCBpdGVtc1tpXVsxXSkpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLmFsbChcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xuICAgICAgLy8gaXRlbVsxXS5ib2R5LmFzQmxvYigpIGlzIHRoZSBvbGQgQVBJXG4gICAgICByZXR1cm4gaXRlbVsxXS5hc0Jsb2IgPyBpdGVtWzFdLmFzQmxvYigpIDogaXRlbVsxXS5ib2R5LmFzQmxvYigpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZUJvZGllcykge1xuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24oaGFzQ2FjaGUpIHtcbiAgICAgICAgaWYgKCFoYXNDYWNoZSkge1xuICAgICAgICAgIHRocm93IEVycm9yKFwiQ2FjaGUgb2YgdGhhdCBuYW1lIGRvZXMgbm90IGV4aXN0XCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtLCBpKSB7XG4gICAgICAgICAgdmFyIHJlcXVlc3QgPSBpdGVtWzBdO1xuICAgICAgICAgIHZhciByZXNwb25zZSA9IGl0ZW1bMV07XG4gICAgICAgICAgdmFyIHJlcXVlc3RFbnRyeSA9IHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpO1xuICAgICAgICAgIHZhciByZXNwb25zZUVudHJ5ID0gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCByZXNwb25zZUJvZGllc1tpXSk7XG5cbiAgICAgICAgICB2YXIgcmVxdWVzdFVybE5vU2VhcmNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoLnNlYXJjaCA9ICcnO1xuICAgICAgICAgIC8vIHdvcmtpbmcgYXJvdW5kIENocm9tZSBidWdcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2ggPSByZXF1ZXN0VXJsTm9TZWFyY2guaHJlZi5yZXBsYWNlKC9cXD8kLywgJycpO1xuXG4gICAgICAgICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuYWRkKHtcbiAgICAgICAgICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogY2FjaGVOYW1lLFxuICAgICAgICAgICAgICByZXF1ZXN0OiByZXF1ZXN0RW50cnksXG4gICAgICAgICAgICAgIHJlc3BvbnNlOiByZXNwb25zZUVudHJ5LFxuICAgICAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2g6IHJlcXVlc3RVcmxOb1NlYXJjaCxcbiAgICAgICAgICAgICAgdmFyeUlEOiBjcmVhdGVWYXJ5SUQocmVxdWVzdEVudHJ5LCByZXNwb25zZUVudHJ5KSxcbiAgICAgICAgICAgICAgYWRkZWQ6IERhdGUubm93KClcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgICB9LmJpbmQodGhpcykpO1xuICAgIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlREIoKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xudmFyIENhY2hlID0gcmVxdWlyZSgnLi9jYWNoZScpO1xuXG5mdW5jdGlvbiBDYWNoZVN0b3JhZ2UoKSB7XG4gIHRoaXMuX29yaWdpbiA9IGxvY2F0aW9uLm9yaWdpbjtcbn1cblxudmFyIENhY2hlU3RvcmFnZVByb3RvID0gQ2FjaGVTdG9yYWdlLnByb3RvdHlwZTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uX3ZlbmRDYWNoZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XG4gIGNhY2hlLl9uYW1lID0gbmFtZTtcbiAgY2FjaGUuX29yaWdpbiA9IHRoaXMuX29yaWdpbjtcbiAgcmV0dXJuIGNhY2hlO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBY3Jvc3NDYWNoZXModGhpcy5fb3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uZ2V0ID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gdGhpcy5oYXMobmFtZSkudGhlbihmdW5jdGlvbihoYXNDYWNoZSkge1xuICAgIHZhciBjYWNoZTtcbiAgICBcbiAgICBpZiAoaGFzQ2FjaGUpIHtcbiAgICAgIHJldHVybiB0aGlzLl92ZW5kQ2FjaGUobmFtZSk7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9LmJpbmQodGhpcykpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uaGFzID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5oYXNDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uY3JlYXRlID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5jcmVhdGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcbiAgfS5iaW5kKHRoaXMpLCBmdW5jdGlvbigpIHtcbiAgICB0aHJvdyBFcnJvcihcIkNhY2hlIGFscmVhZHkgZXhpc3RzXCIpO1xuICB9KTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmtleXMgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIGNhY2hlREIuY2FjaGVOYW1lcyh0aGlzLl9vcmlnaW4pLnRoZW4oZnVuY3Rpb24obmFtZXMpIHtcbiAgICByZXR1cm4gbmFtZXMubWFwKGZ1bmN0aW9uKG5hbWUpIHtcbiAgICAgIHJldHVybiB0aGlzLl92ZW5kQ2FjaGUobmFtZSk7XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlU3RvcmFnZSgpO1xuIiwiZnVuY3Rpb24gSURCSGVscGVyKG5hbWUsIHZlcnNpb24sIHVwZ3JhZGVDYWxsYmFjaykge1xuICB2YXIgcmVxdWVzdCA9IGluZGV4ZWREQi5vcGVuKG5hbWUsIHZlcnNpb24pO1xuICB0aGlzLnJlYWR5ID0gSURCSGVscGVyLnByb21pc2lmeShyZXF1ZXN0KTtcbiAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSBmdW5jdGlvbihldmVudCkge1xuICAgIHVwZ3JhZGVDYWxsYmFjayhyZXF1ZXN0LnJlc3VsdCwgZXZlbnQub2xkVmVyc2lvbik7XG4gIH07XG59XG5cbklEQkhlbHBlci5zdXBwb3J0ZWQgPSAnaW5kZXhlZERCJyBpbiBzZWxmO1xuXG5JREJIZWxwZXIucHJvbWlzaWZ5ID0gZnVuY3Rpb24ob2JqKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICBJREJIZWxwZXIuY2FsbGJhY2tpZnkob2JqLCByZXNvbHZlLCByZWplY3QpO1xuICB9KTtcbn07XG5cbklEQkhlbHBlci5jYWxsYmFja2lmeSA9IGZ1bmN0aW9uKG9iaiwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xuICBmdW5jdGlvbiBvbnN1Y2Nlc3MoZXZlbnQpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2sob2JqLnJlc3VsdCk7XG4gICAgfVxuICAgIHVubGlzdGVuKCk7XG4gIH1cbiAgZnVuY3Rpb24gb25lcnJvcihldmVudCkge1xuICAgIGlmIChlcnJDYWxsYmFjaykge1xuICAgICAgZXJyQ2FsbGJhY2sob2JqLmVycm9yKTtcbiAgICB9XG4gICAgdW5saXN0ZW4oKTtcbiAgfVxuICBmdW5jdGlvbiB1bmxpc3RlbigpIHtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignY29tcGxldGUnLCBvbnN1Y2Nlc3MpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignZXJyb3InLCBvbmVycm9yKTtcbiAgICBvYmoucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbmVycm9yKTtcbiAgfVxuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignY29tcGxldGUnLCBvbnN1Y2Nlc3MpO1xuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignc3VjY2VzcycsIG9uc3VjY2Vzcyk7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICBvYmouYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBvbmVycm9yKTtcbn07XG5cbklEQkhlbHBlci5pdGVyYXRlID0gZnVuY3Rpb24oY3Vyc29yUmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcbiAgdmFyIG9sZEN1cnNvckNvbnRpbnVlO1xuXG4gIGZ1bmN0aW9uIGN1cnNvckNvbnRpbnVlKCkge1xuICAgIHRoaXMuX2NvbnRpbnVpbmcgPSB0cnVlO1xuICAgIHJldHVybiBvbGRDdXJzb3JDb250aW51ZS5jYWxsKHRoaXMpO1xuICB9XG5cbiAgY3Vyc29yUmVxdWVzdC5vbnN1Y2Nlc3MgPSBmdW5jdGlvbigpIHtcbiAgICB2YXIgY3Vyc29yID0gY3Vyc29yUmVxdWVzdC5yZXN1bHQ7XG5cbiAgICBpZiAoIWN1cnNvcikge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoY3Vyc29yLmNvbnRpbnVlICE9IGN1cnNvckNvbnRpbnVlKSB7XG4gICAgICBvbGRDdXJzb3JDb250aW51ZSA9IGN1cnNvci5jb250aW51ZTtcbiAgICAgIGN1cnNvci5jb250aW51ZSA9IGN1cnNvckNvbnRpbnVlO1xuICAgIH1cblxuICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuXG4gICAgaWYgKCFjdXJzb3IuX2NvbnRpbnVpbmcpIHtcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIGN1cnNvclJlcXVlc3Qub25lcnJvciA9IGZ1bmN0aW9uKCkge1xuICAgIGlmIChlcnJvckNhbGxiYWNrKSB7XG4gICAgICBlcnJvckNhbGxiYWNrKGN1cnNvclJlcXVlc3QuZXJyb3IpO1xuICAgIH1cbiAgfTtcbn07XG5cbnZhciBJREJIZWxwZXJQcm90byA9IElEQkhlbHBlci5wcm90b3R5cGU7XG5cbklEQkhlbHBlclByb3RvLnRyYW5zYWN0aW9uID0gZnVuY3Rpb24oc3RvcmVzLCBjYWxsYmFjaywgb3B0cykge1xuICBvcHRzID0gb3B0cyB8fCB7fTtcblxuICByZXR1cm4gdGhpcy5yZWFkeS50aGVuKGZ1bmN0aW9uKGRiKSB7XG4gICAgdmFyIG1vZGUgPSBvcHRzLm1vZGUgfHwgJ3JlYWRvbmx5JztcblxuICAgIHZhciB0eCA9IGRiLnRyYW5zYWN0aW9uKHN0b3JlcywgbW9kZSk7XG4gICAgY2FsbGJhY2sodHgsIGRiKTtcbiAgICByZXR1cm4gSURCSGVscGVyLnByb21pc2lmeSh0eCk7XG4gIH0pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBJREJIZWxwZXI7IiwidmFyIGNhY2hlcyA9IHJlcXVpcmUoJy4uL2xpYnMvY2FjaGVzJyk7XG5cbnNlbGYub25pbnN0YWxsID0gZnVuY3Rpb24oZXZlbnQpIHtcbiAgZXZlbnQud2FpdFVudGlsKFByb21pc2UuYWxsKFtcbiAgICBjYWNoZXMuZ2V0KCdzdGF0aWMtdjEnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICByZXR1cm4gY2FjaGUgfHwgY2FjaGVzLmNyZWF0ZSgnc3RhdGljLXYxJyk7XG4gICAgfSkudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgcmV0dXJuIGNhY2hlLmFkZEFsbChbXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvY3NzL2FsbC5jc3MnLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9qcy9wYWdlLmpzJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvaW1ncy9sb2dvLnN2ZycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2ltZ3MvaWNvbi5wbmcnXG4gICAgICBdKTtcbiAgICB9KSxcbiAgICBjYWNoZXMuZ2V0KCd0cmFpbnMtaW1ncycpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBjYWNoZSB8fCBjYWNoZXMuY3JlYXRlKCd0cmFpbnMtaW1ncycpO1xuICAgIH0pXG4gIF0pKTtcbn07XG5cbnNlbGYub25mZXRjaCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gIHZhciByZXF1ZXN0VVJMID0gbmV3IFVSTChldmVudC5yZXF1ZXN0LnVybCk7XG5cbiAgaWYgKHJlcXVlc3RVUkwuaG9zdG5hbWUgPT0gJ2FwaS5mbGlja3IuY29tJykge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckFQSVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIGlmICgvXFwuc3RhdGljZmxpY2tyXFwuY29tJC8udGVzdChyZXF1ZXN0VVJMLmhvc3RuYW1lKSkge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGZsaWNrckltYWdlUmVzcG9uc2UoZXZlbnQucmVxdWVzdCkpO1xuICB9XG4gIGVsc2Uge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKFxuICAgICAgY2FjaGVzLm1hdGNoKGV2ZW50LnJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoXCJObyByZXNwb25zZVwiKTtcbiAgICAgIH0pXG4gICAgKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gZmxpY2tyQVBJUmVzcG9uc2UocmVxdWVzdCkge1xuICBpZiAocmVxdWVzdC5oZWFkZXJzLmdldCgnQWNjZXB0JykgPT0gJ3gtY2FjaGUvb25seScpIHtcbiAgICByZXR1cm4gY2FjaGVzLm1hdGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKFwiTm8gcmVzcG9uc2VcIik7XG4gICAgfSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGZldGNoKHJlcXVlc3QudXJsKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZSgndHJhaW5zLWltZ3MnKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gY2FjaGVzLmNyZWF0ZSgndHJhaW5zLWltZ3MnKTtcbiAgICAgIH0pLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgICAgY2FjaGUucHV0KHJlcXVlc3QsIHJlc3BvbnNlKTtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmxpY2tySW1hZ2VSZXNwb25zZShyZXF1ZXN0KSB7XG4gIHJldHVybiBjYWNoZXMubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH1cblxuICAgIHJldHVybiBmZXRjaChyZXF1ZXN0LnVybCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgY2FjaGVzLmdldCgndHJhaW5zLWltZ3MnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZSk7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH0pO1xuICB9KTtcbn1cbiJdfQ==
