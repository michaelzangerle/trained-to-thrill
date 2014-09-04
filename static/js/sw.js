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
}

var CacheProto = Cache.prototype;

CacheProto.match = function(request, params) {
  return cacheDB.match(this._name, request, params);
};

CacheProto.matchAll = function(request, params) {
  return cacheDB.matchAll(this._name, request, params);
};

CacheProto.addAll = function(requests) {
  requests = requests.map(castToRequest);

  Promise.all(
    requests.map(function(request) {
      return fetch(request);
    })
  ).then(function(responses) {
    return cacheDB.put(this._name, responses.map(function(response, i) {
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

  return cacheDB.put(this._name, [[request, response]]);
};

CacheProto.delete = function(request, params) {
  request = castToRequest(request);
  return cacheDB.delete(this._name, request, params);
};

CacheProto.keys = function(request, params) {
  if (request) {
    request = castToRequest(request);
    return cacheDB.matchAllRequests(this._name, request, params);
  }
  else {
    return cacheDB.allRequests(this._name);
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
        var namesStore = db.createObjectStore('cacheNames', {autoIncrement: true});
        namesStore.createIndex('cacheName', '', {unique: true});

        var entryStore = db.createObjectStore('cacheEntries', {
          keyPath: ['cacheName', 'request.url', 'varyID']
        });
        entryStore.createIndex('cacheName', 'cacheName');
        entryStore.createIndex('cacheName-urlNoSearch', ['cacheName', 'requestUrlNoSearch']);
        entryStore.createIndex('cacheName-url', ['cacheName', 'request.url']);
    }
  });
}

var CacheDBProto = CacheDB.prototype;

CacheDBProto._eachCacheName = function(tx, eachCallback, doneCallback, errorCallback) {
  IDBHelper.iterate(
    tx.objectStore('cacheNames').openCursor(),
    eachCallback, doneCallback, errorCallback
  );
};

CacheDBProto._eachMatch = function(tx, cacheName, request, eachCallback, doneCallback, errorCallback, params) {
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
  var indexName = 'cacheName-url';
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
    range = IDBKeyRange.bound([cacheName, urlToMatch], [cacheName, urlToMatch + String.fromCharCode(65535)]);
  }
  else {
    range = IDBKeyRange.only([cacheName, urlToMatch]);
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

CacheDBProto._hasCache = function(tx, cacheName, doneCallback, errCallback) {
  var index = tx.objectStore('cacheNames').index('cacheName');
  return IDBHelper.callbackify(index.get(cacheName), function(val) {
    doneCallback(!!val);
  }, errCallback);
};

CacheDBProto._delete = function(tx, cacheName, request, doneCallback, errCallback, params) {
  var returnVal = false;

  this._eachMatch(tx, cacheName, request, function(cursor) {
    returnVal = true;
    cursor.delete();
  }, function() {
    if (doneCallback) {
      doneCallback(returnVal);
    }
  }, errCallback, params);
};

CacheDBProto.matchAllRequests = function(cacheName, request, params) {
  var matches = [];
  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, cacheName, request, function(cursor) {
      matches.push(cursor.key);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.allRequests = function(cacheName) {
  var matches = [];

  return this.db.transaction('cacheEntries', function(tx) {
    var cacheEntries = tx.objectStore('cacheEntries');
    var index = cacheEntries.index('cacheName');

    IDBHelper.iterate(index.openCursor(IDBKeyRange.only(cacheName)), function(cursor) {
      matches.push(cursor.key);
      cursor.continue();
    });
  }).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.matchAll = function(cacheName, request, params) {
  var matches = [];
  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, cacheName, request, function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToResponse);
  });
};

CacheDBProto.match = function(cacheName, request, params) {
  var match;
  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, cacheName, request, function(cursor) {
      match = cursor.value;
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.matchAcrossCaches = function(request, params) {
  var match;

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    this._eachCacheName(tx, function(cursor) {
      var cacheName = cursor.value;
      this._eachMatch(tx, cacheName, request, function(cursor) {
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

CacheDBProto.cacheNames = function() {
  var names = [];

  return this.db.transaction('cacheNames', function(tx) {
    this._eachCacheName(tx, function(cursor) {
      names.push(cursor.value);
      cursor.continue();
    }.bind(this));
  }.bind(this)).then(function() {
    return names;
  });
};

CacheDBProto.delete = function(cacheName, request, params) {
  var returnVal;

  return this.db.transaction('cacheEntries', function(tx) {
    this._delete(tx, cacheName, request, params, function(v) {
      returnVal = v;
    });
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.createCache = function(cacheName) {
  return this.db.transaction('cacheNames', function(tx) {
    var store = tx.objectStore('cacheNames');
    store.add(cacheName);
  }.bind(this), {mode: 'readwrite'});
};

CacheDBProto.hasCache = function(cacheName) {
  var returnVal;
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, cacheName, function(val) {
      returnVal = val;
    });
  }.bind(this)).then(function(val) {
    return returnVal;
  });
};

CacheDBProto.deleteCache = function(cacheName) {
  var returnVal = false;

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    IDBHelper.iterate(
      tx.objectStore('cacheNames').index('cacheName').openCursor(IDBKeyRange.only(cacheName)),
      del
    );

    IDBHelper.iterate(
      tx.objectStore('cacheEntries').index('cacheName').openCursor(IDBKeyRange.only(cacheName)),
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

CacheDBProto.put = function(cacheName, items) {
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
      this._hasCache(tx, cacheName, function(hasCache) {
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

          this._delete(tx, cacheName, request, function() {
            tx.objectStore('cacheEntries').add({
              cacheName: cacheName,
              request: requestEntry,
              response: responseEntry,
              requestUrlNoSearch: requestUrlNoSearch,
              varyID: createVaryID(requestEntry, responseEntry)
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

function CacheStorage() {}

var CacheStorageProto = CacheStorage.prototype;

CacheStorageProto.match = function(request, params) {
  return cacheDB.matchAcrossCaches(request, params);
};

CacheStorageProto.get = function(name) {
  return this.has(name).then(function(hasCache) {
    var cache;
    
    if (hasCache) {
      cache = new Cache();
      cache._name = name;
      return cache;
    }
    else {
      return null;
    }
  });
};

CacheStorageProto.has = function(name) {
  return cacheDB.hasCache(name);
};

CacheStorageProto.create = function(name) {
  return cacheDB.createCache(name).then(function() {
    var cache = new Cache();
    cache._name = name;
    return cache;
  }, function() {
    throw Error("Cache already exists");
  });
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(name);
};

CacheStorageProto.keys = function() {
  return cacheDB.cacheNames().then(function(names) {
    return names.map(function(name) {
      var cache = new Cache();
      cache._name = name;
      return cache;
    });
  });
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
    }),
    caches.get('trains-data').then(function(cache) {
      return cache || caches.create('trains-data');
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
        throw Error("No response");
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
      throw Error("No response");
    });
  }
  else {
    return fetch(request.url).then(function(response) {
      return caches.delete('content').then(function() {
        return caches.create('content');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvY2FjaGUuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlZGIuanMiLCIvVXNlcnMvamFrZWFyY2hpYmFsZC9kZXYvZmxpY2tyLW9mZmxpbmUvd3d3L3N0YXRpYy9qcy11bm1pbi9saWJzL2NhY2hlcy5qcyIsIi9Vc2Vycy9qYWtlYXJjaGliYWxkL2Rldi9mbGlja3Itb2ZmbGluZS93d3cvc3RhdGljL2pzLXVubWluL2xpYnMvaWRiaGVscGVyLmpzIiwiL1VzZXJzL2pha2VhcmNoaWJhbGQvZGV2L2ZsaWNrci1vZmZsaW5lL3d3dy9zdGF0aWMvanMtdW5taW4vc3cvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25FQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BZQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcblxuZnVuY3Rpb24gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KSB7XG4gIGlmICghKHJlcXVlc3QgaW5zdGFuY2VvZiBSZXF1ZXN0KSkge1xuICAgIHJlcXVlc3QgPSBuZXcgUmVxdWVzdChyZXF1ZXN0KTtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZnVuY3Rpb24gQ2FjaGUoKSB7XG4gIHRoaXMuX25hbWUgPSAnJztcbn1cblxudmFyIENhY2hlUHJvdG8gPSBDYWNoZS5wcm90b3R5cGU7XG5cbkNhY2hlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2godGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGwodGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkQWxsID0gZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgcmVxdWVzdHMgPSByZXF1ZXN0cy5tYXAoY2FzdFRvUmVxdWVzdCk7XG5cbiAgUHJvbWlzZS5hbGwoXG4gICAgcmVxdWVzdHMubWFwKGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0KTtcbiAgICB9KVxuICApLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VzKSB7XG4gICAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX25hbWUsIHJlc3BvbnNlcy5tYXAoZnVuY3Rpb24ocmVzcG9uc2UsIGkpIHtcbiAgICAgIHJldHVybiBbcmVxdWVzdHNbaV0sIHJlc3BvbnNlXTtcbiAgICB9KSk7XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVByb3RvLmFkZCA9IGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgcmV0dXJuIHRoaXMuYWRkQWxsKFtyZXF1ZXN0XSk7XG59O1xuXG5DYWNoZVByb3RvLnB1dCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlKSB7XG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgUmVzcG9uc2UpKSB7XG4gICAgdGhyb3cgVHlwZUVycm9yKFwiSW5jb3JyZWN0IHJlc3BvbnNlIHR5cGVcIik7XG4gIH1cblxuICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fbmFtZSwgW1tyZXF1ZXN0LCByZXNwb25zZV1dKTtcbn07XG5cbkNhY2hlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuICByZXR1cm4gY2FjaGVEQi5kZWxldGUodGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICBpZiAocmVxdWVzdCkge1xuICAgIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuICAgIHJldHVybiBjYWNoZURCLm1hdGNoQWxsUmVxdWVzdHModGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbiAgfVxuICBlbHNlIHtcbiAgICByZXR1cm4gY2FjaGVEQi5hbGxSZXF1ZXN0cyh0aGlzLl9uYW1lKTtcbiAgfVxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBDYWNoZTtcbiIsInZhciBJREJIZWxwZXIgPSByZXF1aXJlKCcuL2lkYmhlbHBlcicpO1xuXG5mdW5jdGlvbiBtYXRjaGVzVmFyeShyZXF1ZXN0LCBlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkuc3BsaXQoJywnKTtcbiAgdmFyIHZhcnlIZWFkZXI7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0LmhlYWRlcnMuZ2V0KHZhcnlIZWFkZXIpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVWYXJ5SUQoZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XG4gIHZhciBpZCA9ICcnO1xuXG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcbiAgICByZXR1cm4gaWQ7XG4gIH1cblxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyBlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSArICdcXG4nO1xuICB9XG5cbiAgcmV0dXJuIGlkO1xufVxuXG5mdW5jdGlvbiBmbGF0dGVuSGVhZGVycyhoZWFkZXJzKSB7XG4gIHZhciByZXR1cm5WYWwgPSB7fTtcbiAgaGVhZGVycy5mb3JFYWNoKGZ1bmN0aW9uKHZhbCwga2V5KSB7XG4gICAgcmV0dXJuVmFsW2tleV0gPSB2YWw7XG4gIH0pO1xuXG4gIC8vIHNvIFhIUiBjYW4gcmVhZCB0aGUgcmVzdWx0ICh3ZSBkb24ndCBoYXZlIGFjY2VzcyB0byB0aGlzIGhlYWRlcilcbiAgcmV0dXJuVmFsWydBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nXSA9IGxvY2F0aW9uLm9yaWdpbjtcbiAgcmV0dXJuIHJldHVyblZhbDtcbn1cblxuZnVuY3Rpb24gZW50cnlUb1Jlc3BvbnNlKGVudHJ5KSB7XG4gIHZhciBlbnRyeVJlc3BvbnNlID0gZW50cnkucmVzcG9uc2U7XG4gIHJldHVybiBuZXcgUmVzcG9uc2UoZW50cnlSZXNwb25zZS5ib2R5LCB7XG4gICAgc3RhdHVzOiBlbnRyeVJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiBlbnRyeVJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZW50cnlSZXNwb25zZS5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIGJvZHkpIHtcbiAgcmV0dXJuIHtcbiAgICBib2R5OiBib2R5LFxuICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLFxuICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVzcG9uc2UuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW50cnlUb1JlcXVlc3QoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVxdWVzdCA9IGVudHJ5LnJlcXVlc3Q7XG4gIHJldHVybiBuZXcgUmVxdWVzdChlbnRyeVJlcXVlc3QudXJsLCB7XG4gICAgbW9kZTogZW50cnlSZXF1ZXN0Lm1vZGUsXG4gICAgaGVhZGVyczogZW50cnlSZXF1ZXN0LmhlYWRlcnMsXG4gICAgY3JlZGVudGlhbHM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KSB7XG4gIHJldHVybiB7XG4gICAgdXJsOiByZXF1ZXN0LnVybCxcbiAgICBtb2RlOiByZXF1ZXN0Lm1vZGUsXG4gICAgY3JlZGVudGlhbHM6IHJlcXVlc3QuY3JlZGVudGlhbHMsXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVxdWVzdC5oZWFkZXJzKVxuICB9O1xufVxuXG5mdW5jdGlvbiBDYWNoZURCKCkge1xuICB0aGlzLmRiID0gbmV3IElEQkhlbHBlcignY2FjaGUtcG9seWZpbGwnLCAxLCBmdW5jdGlvbihkYiwgb2xkVmVyc2lvbikge1xuICAgIHN3aXRjaCAob2xkVmVyc2lvbikge1xuICAgICAgY2FzZSAwOlxuICAgICAgICB2YXIgbmFtZXNTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJywge2F1dG9JbmNyZW1lbnQ6IHRydWV9KTtcbiAgICAgICAgbmFtZXNTdG9yZS5jcmVhdGVJbmRleCgnY2FjaGVOYW1lJywgJycsIHt1bmlxdWU6IHRydWV9KTtcblxuICAgICAgICB2YXIgZW50cnlTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAndmFyeUlEJ11cbiAgICAgICAgfSk7XG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ2NhY2hlTmFtZScsICdjYWNoZU5hbWUnKTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnY2FjaGVOYW1lLXVybE5vU2VhcmNoJywgWydjYWNoZU5hbWUnLCAncmVxdWVzdFVybE5vU2VhcmNoJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdjYWNoZU5hbWUtdXJsJywgWydjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnXSk7XG4gICAgfVxuICB9KTtcbn1cblxudmFyIENhY2hlREJQcm90byA9IENhY2hlREIucHJvdG90eXBlO1xuXG5DYWNoZURCUHJvdG8uX2VhY2hDYWNoZU5hbWUgPSBmdW5jdGlvbih0eCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcbiAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5vcGVuQ3Vyc29yKCksXG4gICAgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2tcbiAgKTtcbn07XG5cbkNhY2hlREJQcm90by5fZWFjaE1hdGNoID0gZnVuY3Rpb24odHgsIGNhY2hlTmFtZSwgcmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2ssIHBhcmFtcykge1xuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XG5cbiAgdmFyIGlnbm9yZVNlYXJjaCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVNlYXJjaCk7XG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xuICB2YXIgaWdub3JlVmFyeSA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVZhcnkpO1xuICB2YXIgcHJlZml4TWF0Y2ggPSBCb29sZWFuKHBhcmFtcy5wcmVmaXhNYXRjaCk7XG5cbiAgaWYgKCFpZ25vcmVNZXRob2QgJiZcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnR0VUJyAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xuICAgIC8vIHdlIG9ubHkgc3RvcmUgR0VUIHJlc3BvbnNlcyBhdCB0aGUgbW9tZW50LCBzbyBubyBtYXRjaFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gIHZhciByYW5nZTtcbiAgdmFyIGluZGV4O1xuICB2YXIgaW5kZXhOYW1lID0gJ2NhY2hlTmFtZS11cmwnO1xuICB2YXIgdXJsVG9NYXRjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xuXG4gIHVybFRvTWF0Y2guaGFzaCA9ICcnO1xuXG4gIGlmIChpZ25vcmVTZWFyY2gpIHtcbiAgICB1cmxUb01hdGNoLnNlYXJjaCA9ICcnO1xuICAgIGluZGV4TmFtZSArPSAnTm9TZWFyY2gnO1xuICB9XG5cbiAgLy8gd29ya2luZyBhcm91bmQgY2hyb21lIGJ1Z3NcbiAgdXJsVG9NYXRjaCA9IHVybFRvTWF0Y2guaHJlZi5yZXBsYWNlKC8oXFw/fCN8XFw/IykkLywgJycpO1xuXG4gIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KGluZGV4TmFtZSk7XG5cbiAgaWYgKHByZWZpeE1hdGNoKSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbY2FjaGVOYW1lLCB1cmxUb01hdGNoXSwgW2NhY2hlTmFtZSwgdXJsVG9NYXRjaCArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjU1MzUpXSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5vbmx5KFtjYWNoZU5hbWUsIHVybFRvTWF0Y2hdKTtcbiAgfVxuXG4gIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICB2YXIgdmFsdWUgPSBjdXJzb3IudmFsdWU7XG4gICAgXG4gICAgaWYgKGlnbm9yZVZhcnkgfHwgbWF0Y2hlc1ZhcnkocmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXNwb25zZSkpIHtcbiAgICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfSwgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5faGFzQ2FjaGUgPSBmdW5jdGlvbih0eCwgY2FjaGVOYW1lLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIHZhciBpbmRleCA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ2NhY2hlTmFtZScpO1xuICByZXR1cm4gSURCSGVscGVyLmNhbGxiYWNraWZ5KGluZGV4LmdldChjYWNoZU5hbWUpLCBmdW5jdGlvbih2YWwpIHtcbiAgICBkb25lQ2FsbGJhY2soISF2YWwpO1xuICB9LCBlcnJDYWxsYmFjayk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2RlbGV0ZSA9IGZ1bmN0aW9uKHR4LCBjYWNoZU5hbWUsIHJlcXVlc3QsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2ssIHBhcmFtcykge1xuICB2YXIgcmV0dXJuVmFsID0gZmFsc2U7XG5cbiAgdGhpcy5fZWFjaE1hdGNoKHR4LCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHJldHVyblZhbCA9IHRydWU7XG4gICAgY3Vyc29yLmRlbGV0ZSgpO1xuICB9LCBmdW5jdGlvbigpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2socmV0dXJuVmFsKTtcbiAgICB9XG4gIH0sIGVyckNhbGxiYWNrLCBwYXJhbXMpO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsUmVxdWVzdHMgPSBmdW5jdGlvbihjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmFsbFJlcXVlc3RzID0gZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcbiAgICB2YXIgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoJ2NhY2hlTmFtZScpO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihJREJLZXlSYW5nZS5vbmx5KGNhY2hlTmFtZSkpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3Iua2V5KTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0pO1xuICB9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24oY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVzcG9uc2UpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaCA9IGZ1bmN0aW9uKGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaDtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFjcm9zc0NhY2hlcyA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZU5hbWUodHgsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgdmFyIGNhY2hlTmFtZSA9IGN1cnNvci52YWx1ZTtcbiAgICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XG4gICAgICAgIC8vIHdlJ3JlIGRvbmVcbiAgICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuXG4gICAgICBpZiAoIW1hdGNoKSB7IC8vIGNvbnRpbnVlIGlmIG5vIG1hdGNoXG4gICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgfVxuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5jYWNoZU5hbWVzID0gZnVuY3Rpb24oKSB7XG4gIHZhciBuYW1lcyA9IFtdO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGVOYW1lKHR4LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG5hbWVzLnB1c2goY3Vyc29yLnZhbHVlKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbmFtZXM7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciByZXR1cm5WYWw7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZGVsZXRlKHR4LCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcywgZnVuY3Rpb24odikge1xuICAgICAgcmV0dXJuVmFsID0gdjtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmNyZWF0ZUNhY2hlID0gZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xuICAgIHN0b3JlLmFkZChjYWNoZU5hbWUpO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xufTtcblxuQ2FjaGVEQlByb3RvLmhhc0NhY2hlID0gZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWw7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcbiAgICAgIHJldHVyblZhbCA9IHZhbDtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKHZhbCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZUNhY2hlID0gZnVuY3Rpb24oY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLmluZGV4KCdjYWNoZU5hbWUnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLm9ubHkoY2FjaGVOYW1lKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuaW5kZXgoJ2NhY2hlTmFtZScpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2Uub25seShjYWNoZU5hbWUpKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBmdW5jdGlvbiBkZWwoY3Vyc29yKSB7XG4gICAgICByZXR1cm5WYWwgPSB0cnVlO1xuICAgICAgY3Vyc29yLmRlbGV0ZSgpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfVxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ucHV0ID0gZnVuY3Rpb24oY2FjaGVOYW1lLCBpdGVtcykge1xuICAvLyBpdGVtcyBpcyBbW3JlcXVlc3QsIHJlc3BvbnNlXSwgW3JlcXVlc3QsIHJlc3BvbnNlXSwg4oCmXVxuICB2YXIgaXRlbTtcblxuICBmb3IgKHZhciBpID0gMTsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignT25seSBHRVQgcmVxdWVzdHMgYXJlIHN1cHBvcnRlZCcpKTtcbiAgICB9XG5cbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xuICAgICAgaWYgKGl0ZW1zW2ldWzBdLnVybCA9PSBpdGVtc1tqXVswXS51cmwgJiYgbWF0Y2hlc1ZhcnkoaXRlbXNbal1bMF0sIGl0ZW1zW2ldWzBdLCBpdGVtc1tpXVsxXSkpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLmFsbChcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xuICAgICAgLy8gaXRlbVsxXS5ib2R5LmFzQmxvYigpIGlzIHRoZSBvbGQgQVBJXG4gICAgICByZXR1cm4gaXRlbVsxXS5hc0Jsb2IgPyBpdGVtWzFdLmFzQmxvYigpIDogaXRlbVsxXS5ib2R5LmFzQmxvYigpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZUJvZGllcykge1xuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBjYWNoZU5hbWUsIGZ1bmN0aW9uKGhhc0NhY2hlKSB7XG4gICAgICAgIGlmICghaGFzQ2FjaGUpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcihcIkNhY2hlIG9mIHRoYXQgbmFtZSBkb2VzIG5vdCBleGlzdFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGl0ZW1zLmZvckVhY2goZnVuY3Rpb24oaXRlbSwgaSkge1xuICAgICAgICAgIHZhciByZXF1ZXN0ID0gaXRlbVswXTtcbiAgICAgICAgICB2YXIgcmVzcG9uc2UgPSBpdGVtWzFdO1xuICAgICAgICAgIHZhciByZXF1ZXN0RW50cnkgPSByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KTtcbiAgICAgICAgICB2YXIgcmVzcG9uc2VFbnRyeSA9IHJlc3BvbnNlVG9FbnRyeShyZXNwb25zZSwgcmVzcG9uc2VCb2RpZXNbaV0pO1xuXG4gICAgICAgICAgdmFyIHJlcXVlc3RVcmxOb1NlYXJjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaC5zZWFyY2ggPSAnJztcbiAgICAgICAgICAvLyB3b3JraW5nIGFyb3VuZCBDaHJvbWUgYnVnXG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoID0gcmVxdWVzdFVybE5vU2VhcmNoLmhyZWYucmVwbGFjZSgvXFw/JC8sICcnKTtcblxuICAgICAgICAgIHRoaXMuX2RlbGV0ZSh0eCwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5hZGQoe1xuICAgICAgICAgICAgICBjYWNoZU5hbWU6IGNhY2hlTmFtZSxcbiAgICAgICAgICAgICAgcmVxdWVzdDogcmVxdWVzdEVudHJ5LFxuICAgICAgICAgICAgICByZXNwb25zZTogcmVzcG9uc2VFbnRyeSxcbiAgICAgICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoOiByZXF1ZXN0VXJsTm9TZWFyY2gsXG4gICAgICAgICAgICAgIHZhcnlJRDogY3JlYXRlVmFyeUlEKHJlcXVlc3RFbnRyeSwgcmVzcG9uc2VFbnRyeSlcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgICB9LmJpbmQodGhpcykpO1xuICAgIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlREIoKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xudmFyIENhY2hlID0gcmVxdWlyZSgnLi9jYWNoZScpO1xuXG5mdW5jdGlvbiBDYWNoZVN0b3JhZ2UoKSB7fVxuXG52YXIgQ2FjaGVTdG9yYWdlUHJvdG8gPSBDYWNoZVN0b3JhZ2UucHJvdG90eXBlO1xuXG5DYWNoZVN0b3JhZ2VQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFjcm9zc0NhY2hlcyhyZXF1ZXN0LCBwYXJhbXMpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8uZ2V0ID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gdGhpcy5oYXMobmFtZSkudGhlbihmdW5jdGlvbihoYXNDYWNoZSkge1xuICAgIHZhciBjYWNoZTtcbiAgICBcbiAgICBpZiAoaGFzQ2FjaGUpIHtcbiAgICAgIGNhY2hlID0gbmV3IENhY2hlKCk7XG4gICAgICBjYWNoZS5fbmFtZSA9IG5hbWU7XG4gICAgICByZXR1cm4gY2FjaGU7XG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9KTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmhhcyA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuaGFzQ2FjaGUobmFtZSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5jcmVhdGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmNyZWF0ZUNhY2hlKG5hbWUpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XG4gICAgY2FjaGUuX25hbWUgPSBuYW1lO1xuICAgIHJldHVybiBjYWNoZTtcbiAgfSwgZnVuY3Rpb24oKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJDYWNoZSBhbHJlYWR5IGV4aXN0c1wiKTtcbiAgfSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5kZWxldGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZUNhY2hlKG5hbWUpO1xufTtcblxuQ2FjaGVTdG9yYWdlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gY2FjaGVEQi5jYWNoZU5hbWVzKCkudGhlbihmdW5jdGlvbihuYW1lcykge1xuICAgIHJldHVybiBuYW1lcy5tYXAoZnVuY3Rpb24obmFtZSkge1xuICAgICAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XG4gICAgICBjYWNoZS5fbmFtZSA9IG5hbWU7XG4gICAgICByZXR1cm4gY2FjaGU7XG4gICAgfSk7XG4gIH0pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVTdG9yYWdlKCk7XG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XG4gIHZhciByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4obmFtZSwgdmVyc2lvbik7XG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xuICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gICAgdXBncmFkZUNhbGxiYWNrKHJlcXVlc3QucmVzdWx0LCBldmVudC5vbGRWZXJzaW9uKTtcbiAgfTtcbn1cblxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdpbmRleGVkREInIGluIHNlbGY7XG5cbklEQkhlbHBlci5wcm9taXNpZnkgPSBmdW5jdGlvbihvYmopIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIElEQkhlbHBlci5jYWxsYmFja2lmeShvYmosIHJlc29sdmUsIHJlamVjdCk7XG4gIH0pO1xufTtcblxuSURCSGVscGVyLmNhbGxiYWNraWZ5ID0gZnVuY3Rpb24ob2JqLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhvYmoucmVzdWx0KTtcbiAgICB9XG4gICAgdW5saXN0ZW4oKTtcbiAgfVxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XG4gICAgaWYgKGVyckNhbGxiYWNrKSB7XG4gICAgICBlcnJDYWxsYmFjayhvYmouZXJyb3IpO1xuICAgIH1cbiAgICB1bmxpc3RlbigpO1xuICB9XG4gIGZ1bmN0aW9uIHVubGlzdGVuKCkge1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3N1Y2Nlc3MnLCBvbnN1Y2Nlc3MpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xuICB9XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7XG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xufTtcblxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xuICB2YXIgb2xkQ3Vyc29yQ29udGludWU7XG5cbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XG4gICAgdGhpcy5fY29udGludWluZyA9IHRydWU7XG4gICAgcmV0dXJuIG9sZEN1cnNvckNvbnRpbnVlLmNhbGwodGhpcyk7XG4gIH1cblxuICBjdXJzb3JSZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcblxuICAgIGlmICghY3Vyc29yKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcbiAgICAgIG9sZEN1cnNvckNvbnRpbnVlID0gY3Vyc29yLmNvbnRpbnVlO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlID0gY3Vyc29yQ29udGludWU7XG4gICAgfVxuXG4gICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG5cbiAgICBpZiAoIWN1cnNvci5fY29udGludWluZykge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY3Vyc29yUmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcbiAgICAgIGVycm9yQ2FsbGJhY2soY3Vyc29yUmVxdWVzdC5lcnJvcik7XG4gICAgfVxuICB9O1xufTtcblxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcblxuSURCSGVscGVyUHJvdG8udHJhbnNhY3Rpb24gPSBmdW5jdGlvbihzdG9yZXMsIGNhbGxiYWNrLCBvcHRzKSB7XG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xuXG4gIHJldHVybiB0aGlzLnJlYWR5LnRoZW4oZnVuY3Rpb24oZGIpIHtcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xuXG4gICAgdmFyIHR4ID0gZGIudHJhbnNhY3Rpb24oc3RvcmVzLCBtb2RlKTtcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xuICAgIHJldHVybiBJREJIZWxwZXIucHJvbWlzaWZ5KHR4KTtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IElEQkhlbHBlcjsiLCJ2YXIgY2FjaGVzID0gcmVxdWlyZSgnLi4vbGlicy9jYWNoZXMnKTtcblxuc2VsZi5vbmluc3RhbGwgPSBmdW5jdGlvbihldmVudCkge1xuICBldmVudC53YWl0VW50aWwoUHJvbWlzZS5hbGwoW1xuICAgIGNhY2hlcy5nZXQoJ3N0YXRpYy12MScpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBjYWNoZSB8fCBjYWNoZXMuY3JlYXRlKCdzdGF0aWMtdjEnKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICByZXR1cm4gY2FjaGUuYWRkQWxsKFtcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC8nLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9jc3MvYWxsLmNzcycsXG4gICAgICAgICcvdHJhaW5lZC10by10aHJpbGwvc3RhdGljL2pzL3BhZ2UuanMnLFxuICAgICAgICAnL3RyYWluZWQtdG8tdGhyaWxsL3N0YXRpYy9pbWdzL2xvZ28uc3ZnJyxcbiAgICAgICAgJy90cmFpbmVkLXRvLXRocmlsbC9zdGF0aWMvaW1ncy9pY29uLnBuZydcbiAgICAgIF0pO1xuICAgIH0pLFxuICAgIGNhY2hlcy5nZXQoJ3RyYWlucy1pbWdzJykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgcmV0dXJuIGNhY2hlIHx8IGNhY2hlcy5jcmVhdGUoJ3RyYWlucy1pbWdzJyk7XG4gICAgfSksXG4gICAgY2FjaGVzLmdldCgndHJhaW5zLWRhdGEnKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICByZXR1cm4gY2FjaGUgfHwgY2FjaGVzLmNyZWF0ZSgndHJhaW5zLWRhdGEnKTtcbiAgICB9KVxuICBdKSk7XG59O1xuXG5zZWxmLm9uZmV0Y2ggPSBmdW5jdGlvbihldmVudCkge1xuICB2YXIgcmVxdWVzdFVSTCA9IG5ldyBVUkwoZXZlbnQucmVxdWVzdC51cmwpO1xuXG4gIGlmIChyZXF1ZXN0VVJMLmhvc3RuYW1lID09ICdhcGkuZmxpY2tyLmNvbScpIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChmbGlja3JBUElSZXNwb25zZShldmVudC5yZXF1ZXN0KSk7XG4gIH1cbiAgZWxzZSBpZiAoL1xcLnN0YXRpY2ZsaWNrclxcLmNvbSQvLnRlc3QocmVxdWVzdFVSTC5ob3N0bmFtZSkpIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChmbGlja3JJbWFnZVJlc3BvbnNlKGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxuICBlbHNlIHtcbiAgICBldmVudC5yZXNwb25kV2l0aChcbiAgICAgIGNhY2hlcy5tYXRjaChldmVudC5yZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBFcnJvcihcIk5vIHJlc3BvbnNlXCIpO1xuICAgICAgfSlcbiAgICApO1xuICB9XG59O1xuXG5mdW5jdGlvbiBmbGlja3JBUElSZXNwb25zZShyZXF1ZXN0KSB7XG4gIGlmIChyZXF1ZXN0LmhlYWRlcnMuZ2V0KCdBY2NlcHQnKSA9PSAneC1jYWNoZS9vbmx5Jykge1xuICAgIHJldHVybiBjYWNoZXMubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgIH1cbiAgICAgIHRocm93IEVycm9yKFwiTm8gcmVzcG9uc2VcIik7XG4gICAgfSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGZldGNoKHJlcXVlc3QudXJsKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZSgnY29udGVudCcpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBjYWNoZXMuY3JlYXRlKCdjb250ZW50Jyk7XG4gICAgICB9KS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZSk7XG4gICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZsaWNrckltYWdlUmVzcG9uc2UocmVxdWVzdCkge1xuICByZXR1cm4gY2FjaGVzLm1hdGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICB9XG5cbiAgICByZXR1cm4gZmV0Y2gocmVxdWVzdC51cmwpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgIGNhY2hlcy5nZXQoJ3RyYWlucy1pbWdzJykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgICBjYWNoZS5wdXQocmVxdWVzdCwgcmVzcG9uc2UpO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICB9KTtcbiAgfSk7XG59XG4iXX0=
