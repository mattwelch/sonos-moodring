'use strict';

/* Edit these variables to suit your needs */
var PLAYER_NAME = 'family room';
var LIGHT_SETTINGS = [{light:"LivingColors 1",color:1},{light:"LivingColors 2",color:2}];
var ERROR_OR_NO_RESULT_COLOR = [{color:"#330033"}];
var NEXT_SONG_CACHING_ENABLED = true;
var APP_USERNAME = "sonos-moodring";
var APP_DESCRIPTION = "Display cover art colors from Sonos";
var VERBOSE_MODE = true;

/* <><><><><><><><><><><><><><>*/
/* DO NOT EDIT PAST THIS LINE  */

var config = require('./config.js');

var SonosDiscovery = require('sonos-discovery'),
	discovery = new SonosDiscovery();
var player;

var covers = require('album-cover')(config.lastfmKey);

var unirest = require('unirest');

var hue = require("node-hue-api"),
	HueApi = hue.HueApi,
	lightState = hue.lightState;

var api, hostname;
var lights = {};
var colorCache = {};

// Wait until the Sonos discovery process is done, then grab our player
discovery.on('topology-change', function() {
    if (!player)
        player = discovery.getPlayer(PLAYER_NAME);
})

// If we get a change of state...
discovery.on('transport-state', function(msg) {
	// Make sure we've got a player, and that that player is the subject of the state change, and that we've switch to "playing"
    if (!player || msg.uuid != player.coordinator.uuid || msg.state.zoneState != "PLAYING") {
    	return;
    }

    // these will be the keys for our cached lights object: {artistAlbum:[r,g,b]}
	var currentArtistAlbum = msg.state.currentTrack.artist+msg.state.currentTrack.album;
	var nextArtistAlbum = msg.state.nextTrack !== undefined?msg.state.nextTrack.artist+msg.state.nextTrack.album:'';

	// If we've already fetched this albumArtist, no need to burn an API call fetching it again
    if (colorCache[currentArtistAlbum] !== undefined && colorCache[currentArtistAlbum].length > 0) {
		logMe("Got cached results for album "+msg.state.currentTrack.album+" by "+msg.state.currentTrack.artist+".");
    	lightItUp(colorCache[currentArtistAlbum]);
    }
    // If not, let's grab it
    else if (colorCache[currentArtistAlbum] === undefined) {
    	colorCache[currentArtistAlbum] = [];
    	// Call our getColors method, passing in a callback to act on the results
    	getColors(msg.state.currentTrack.artist, msg.state.currentTrack.album, function(result) {
			// If we didn't get anything back, assume no cover art for this artistAlbum, and
			// set our default colors
			if (result.body === undefined || result.body.tags === undefined) {
				logMe("No artwork found for "+msg.state.currentTrack.album+" by "+msg.state.currentTrack.artist+".");
				colorCache[currentArtistAlbum] = ERROR_OR_NO_RESULT_COLOR;
				lightItUp(ERROR_OR_NO_RESULT_COLOR);
				return;
			}
			// ...otherwise, cache our results and set the lights to those results
			logMe("Fetched color for album "+msg.state.currentTrack.album+" by "+msg.state.currentTrack.artist+".");
			colorCache[currentArtistAlbum] = result.body.tags;
			lightItUp(result.body.tags);
    	});
    }

    // If there is no next album, or we've already fetched it, or we've disabled next album caching, finish up
    if (nextArtistAlbum == '' || colorCache[nextArtistAlbum] !== undefined || !NEXT_SONG_CACHING_ENABLED) {
    	return;
    }
    // otherwise, go through the same flow for the next song (minus the actual setting of the lights)
	colorCache[nextArtistAlbum] = [];
	getColors(msg.state.nextTrack.artist, msg.state.nextTrack.album, function(result) {
		if (result.body === undefined || result.body.tags === undefined) {
			logMe("No artwork found for next album "+msg.state.nextTrack.album+" by "+msg.state.nextTrack.artist+".");
			colorCache[nextArtistAlbum] = ERROR_OR_NO_RESULT_COLOR;
			return;
		}
		logMe("Cached next album "+msg.state.nextTrack.album+" by "+msg.state.nextTrack.artist+".");
		colorCache[nextArtistAlbum] = result.body.tags;
	});

});


function getColors(artist, album, callback) {
	// use album-covers to query lastfm
	covers.search({
		artist: artist,
		album: album,
		size: 'mega'
	}, function(err, res) {
		if (err) {
			logMe(err);
			return;
		}
		logMe('calling out to ColorAPI');
		// grab our results from lastFM, and turn around and send them to the ColorAPI
		unirest.get("https://apicloud-colortag.p.mashape.com/tag-url.json?palette=simple&sort=weight&url="+encodeURIComponent(res))
			.header("X-Mashape-Key", config.mashapeKey)
			.header("Accept", "application/json")
			.end(function (result) {
				// And invoke the supplied callback
				callback(result);
		});

	});

}

// function to actually light up the hues
function lightItUp(colors) {
	// go through each of the supplied colors (from the Color API)
	for (var ti = 0; ti < colors.length; ti++) {
		// And if we haven't defined any lights for this color dominance level, continue
		if (lights[ti] === undefined) {
			continue;
		}
		var thisColor=colors[ti].color.replace('#','');
		// otherwise, cycle through all the lights we've assigned the dominance level, and
		// set their values to the color for this level
		for (var li = 0; li < lights[ti].length; li++) {
		    var state = lightState.create().on().rgb(hexToRgb(thisColor));
		    api.setLightState(parseInt(lights[ti][li]), state)
		    .then(displayResult)
		    .fail(displayError)
		    .done();
		}
	}

}

var displayError = function(err) {
    logMe("Error: "+err);
};

var displayResult = function(result) {
	logMe("Result: " + JSON.stringify(result));
};

var registeredUser = function(registerResult) {
	logMe('Created user '+APP_USERNAME);
	api = new HueApi(hostname,APP_USERNAME);
	api.lights().then(showLights);
};

var findBridges = function(bridge) {
	logMe("Hue Bridges Found: " + JSON.stringify(bridge));
	if (bridge.length == 0) {
		return;
	}
	hostname = bridge[0].ipaddress;
	api = new HueApi(hostname,APP_USERNAME);
	return api.config();
};

var checkConfig = function(result) {
	if (result.ipaddress === undefined) {
		api = new HueApi();
		return api.registerUser(hostname,APP_USERNAME,APP_DESCRIPTION)
		.then(registeredUser)
		.fail(displayError)
		.done();
	}
	else {
		logMe(JSON.stringify(result));
		return api.lights();
	}
    logMe('config results: '+JSON.stringify(result, null, 2));
};

var showLights = function(result) {
    logMe('Lights: '+JSON.stringify(result, null, 2));
    if (result === undefined || result.lights === undefined) {
    	return;
    }
    for (var lsi = 0; lsi < LIGHT_SETTINGS.length; lsi++) {
    	var ls = LIGHT_SETTINGS[lsi];
    	if (lights[ls.color] === undefined) {
    		lights[ls.color] = [];
    	}
    	for (var ri = 0; ri < result.lights.length; ri++) {
    		var r = result.lights[ri];
    		if (r.name == ls.light) {
    			lights[ls.color].push(r.id);
    		}
    	}
    }
    logMe(lights);
};

// Go through the routine of checking for a bridge, creating a new app if necessary, finding out lights
// and creating the object we'll use to assign colors to lights
hue.nupnpSearch().then(findBridges).then(checkConfig).then(showLights).done();

function logMe(msg) {
	if (VERBOSE_MODE) {
		console.log(msg);
	}
}

function hexToRgb(hex) {
    var bigint = parseInt(hex, 16);
    var r = (bigint >> 16) & 255;
    var g = (bigint >> 8) & 255;
    var b = bigint & 255;

    return [r, g, b];
}