'use strict';

var config = require('./config.js');

var LIGHT_SETTINGS = [{light:"LivingColors 1",color:1},{light:"LivingColors 2",color:2}];
var ERROR_OR_NO_RESULT_COLOR = [{color:"#330033"}];
var NEXT_SONG_CACHING_ENABLED = true;
var APP_USERNAME = "sonos-moodring";
var APP_DESCRIPTION = "Display cover art colors from Sonos";

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
        player = discovery.getPlayer('family room');
})

// If we get a change of state...
discovery.on('transport-state', function(msg) {
	// Make sure we've got a player, and that that player is the subject of the state change, and that we've switch to "playing"
    if (!player || msg.uuid != player.coordinator.uuid || msg.state.zoneState != "PLAYING") {
    	return;
    }

	var currentArtistAlbum = msg.state.currentTrack.artist+msg.state.currentTrack.album;
	var nextArtistAlbum = msg.state.nextTrack !== undefined?msg.state.nextTrack.artist+msg.state.nextTrack.album:'';

    if (colorCache[currentArtistAlbum] !== undefined && colorCache[currentArtistAlbum].length > 0) {
    	lightItUp(colorCache[currentArtistAlbum]);
    }
    else if (colorCache[currentArtistAlbum] === undefined) {
    	colorCache[currentArtistAlbum] = [];
    	getColors(msg.state.currentTrack.artist, msg.state.currentTrack.album, function(result) {
			if (result.body === undefined || result.body.tags === undefined) {
				console.log("no artwork found");
				colorCache[currentArtistAlbum] = ERROR_OR_NO_RESULT_COLOR;
				lightItUp(ERROR_OR_NO_RESULT_COLOR);
				return;
			}
			colorCache[currentArtistAlbum] = result.body.tags;
			lightItUp(result.body.tags);
    	});
    }

    if (nextArtistAlbum == '' || colorCache[nextArtistAlbum] !== undefined || !NEXT_SONG_CACHING_ENABLED) {
    	return;
    }
	colorCache[nextArtistAlbum] = [];
	getColors(msg.state.nextTrack.artist, msg.state.nextTrack.album, function(result) {
		if (result.body === undefined || result.body.tags === undefined) {
			console.log("no artwork found");
			colorCache[nextArtistAlbum] = ERROR_OR_NO_RESULT_COLOR;
			return;
		}
		colorCache[nextArtistAlbum] = result.body.tags;
	});

});

function getColors(artist, album, callback) {
	covers.search({
		artist: artist,
		album: album,
		size: 'mega'
	}, function(err, res) {
		if (err) {
			console.log(err);
			return;
		}
		console.log('calling out');
		unirest.get("https://apicloud-colortag.p.mashape.com/tag-url.json?palette=simple&sort=weight&url="+encodeURIComponent(res))
			.header("X-Mashape-Key", config.mashapeKey)
			.header("Accept", "application/json")
			.end(function (result) {
				callback(result);
		});

	});

}

function lightItUp(colors) {
	for (var ti = 0; ti < colors.length; ti++) {
		if (lights[ti] === undefined) {
			continue;
		}
		var thisColor=colors[ti].color.replace('#','');
		console.log(thisColor);
		console.log(hexToRgb(thisColor));
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
    console.log("Error: "+err);
};

var displayResult = function(result) {
	console.log("Result: " + JSON.stringify(result));
};

var registeredUser = function(registerResult) {
	console.log('Created user '+APP_USERNAME);
	api = new HueApi(hostname,APP_USERNAME);
	api.lights().then(showLights);
};

var findBridges = function(bridge) {
	console.log("Hue Bridges Found: " + JSON.stringify(bridge));
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
		console.log(JSON.stringify(result));
		return api.lights();
	}
    console.log('config results: '+JSON.stringify(result, null, 2));
};

var showLights = function(result) {
    console.log('Lights: '+JSON.stringify(result, null, 2));
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
    console.log(lights);
};

// --------------------------
// Using a promise
hue.nupnpSearch().then(findBridges).then(checkConfig).then(showLights).done();


function hexToRgb(hex) {
    var bigint = parseInt(hex, 16);
    var r = (bigint >> 16) & 255;
    var g = (bigint >> 8) & 255;
    var b = bigint & 255;

    return [r, g, b];
}