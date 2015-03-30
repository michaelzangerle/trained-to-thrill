var Promise = require('es6-promise').Promise;
var flickr = require('./flickr');
var photosTemplate = require('./views/photos.hbs');
var utils = require('./utils');

// force https
if ((!location.port || location.port == "80") && location.protocol != 'https:') {
  location.protocol = 'https:';
}

var photosEl = document.querySelector('.photos');
var refreshButton = document.querySelector('button.refresh');
var msgEl = document.querySelector('.msg-container');
var msgContentEl = document.querySelector('.msg');
var photoIDsDisplayed = null;

// STARTING POINT: start the service worker if available
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/trained-to-thrill/sw.js', {
    scope: '/trained-to-thrill/'
  }).then(function(reg) {
    console.log('◕‿◕', reg);
  }, function(err) {
    console.log('ಠ_ಠ', err);
  });
}

/**
 * Shows the spinner icon
 */
function showSpinner() {
  refreshButton.classList.add('loading');
}

/**
 * Hides the spinner icon
 */
function hideSpinner() {
  refreshButton.classList.remove('loading');
}

/**
 * Updates the current page with new data (photos) and inserts them at the top
 * @param data
 */
function updatePage(data) {
  var scrollHeight;

  if (photoIDsDisplayed) {
    scrollHeight = photosEl.scrollHeight;

    data = data.filter(function(photo) {
      if (photoIDsDisplayed.indexOf(photo.id) == -1) {
        photoIDsDisplayed.push(photo.id);
        return true;
      }
      return false;
    });

    photosEl.insertBefore(utils.strToEls(photosTemplate(data)), photosEl.firstChild);
    photosEl.scrollTop += photosEl.scrollHeight - scrollHeight;
  }
  else {
    photoIDsDisplayed = data.map(function(p) { return p.id; });
    photosEl.insertBefore(utils.strToEls(photosTemplate(data)), photosEl.firstChild);
  }
}

/**
 * Gets the data for images in context of train stations
 * @returns {Promise}
 */
function getTrainPhotoData() {
  return flickr.search('train station', {
    headers: {}
  }).catch(function() {
    return null;
  });
}

/**
 *
 * @returns {*}
 */
function getCachedTrainPhotoData() {
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    return flickr.search('train station', {
      headers: {'Accept': 'x-cache/only'}
    }).catch(function() {
      return null;
    });
  }
  else {
    return Promise.resolve(null);
  }
}

/**
 * Show a message with given text and for a given amount of time
 * @param msg
 * @param duration
 */
function showMessage(msg, duration) {
  msgContentEl.textContent = msg;
  msgEl.style.display = 'block';
  msgEl.offsetWidth;
  msgEl.classList.add('show');
  setTimeout(function() {
    msgEl.classList.remove('show');
  }, duration);
}

/**
 *  Shows message when problems with connection
 */
function showConnectionError() {
  showMessage("Connectivity derailed!", 5000);
}

/**
 * Refresh-button click handler
 */
refreshButton.addEventListener('click', function(event) {
  this.blur();
  event.preventDefault();
  showSpinner();
  getTrainPhotoData().then(function(data) {
    var oldLen = photoIDsDisplayed && photoIDsDisplayed.length;
    updatePage(data);
    if (oldLen != photoIDsDisplayed.length) {
      photosEl.scrollTop = 0;
    }
  }).catch(showConnectionError).then(hideSpinner);
});

/**
 * Load live train photos
 * @type {Promise}
 */
var liveDataFetched = getTrainPhotoData().then(function(data) {
  if (data) {
    var alreadyRendered = !!photoIDsDisplayed;
    var oldLen = photoIDsDisplayed && photoIDsDisplayed.length;
    updatePage(data);
    if (alreadyRendered && oldLen != photoIDsDisplayed.length) {
      showMessage("▲ New trains ▲", 3000);
    }
    return true;
  }
  return false;
});

/**
 * Loaded cached train photos
 * Is used as fallback if no live data is available
 * @type {Promise}
 */
var cachedDataFetched = getCachedTrainPhotoData().then(function(data) {
  if (data) {
    if (!photoIDsDisplayed) {
      updatePage(data);
    }
    return true;
  }
  return false;
});

/**
 * When fetching live data is done return the new data or the cached data when live is not available
 * When cached data is displayed show an error message
 */
liveDataFetched.then(function(fetched) {
  return fetched || cachedDataFetched;
}).then(function(dataFetched) {
  if (!dataFetched) {
    showConnectionError();
  }
  hideSpinner();
});

// Add classes to fade-in images
document.addEventListener('load', function(event) {
  if (event.target.classList.contains('main-photo-img')) {
    event.target.parentNode.classList.add('loaded');
  }
}, true);
