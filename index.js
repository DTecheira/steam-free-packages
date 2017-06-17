var SteamAuth = require("steamauth"),
SteamUser = require("steam-user"),
SteamCommunity = require("steamcommunity"),
jsdom = require("jsdom"),
$ = require("jquery")(jsdom.jsdom().defaultView),
fs = require("fs"),
request = require("request"),
CloudScraper = require("cloudscraper");

var log = console.log;
console.log = function() {
    var first_parameter = arguments[0];
    var other_parameters = Array.prototype.slice.call(arguments, 1);
    function formatConsoleDate(date) {
        var day = date.getDate();
        var month = date.getMonth() + 1;
        var year = date.getFullYear();
        var hour = date.getHours();
        var minutes = date.getMinutes();
        var seconds = date.getSeconds();
        var milliseconds = date.getMilliseconds();
        return "[" + ((day < 10) ? "0" + day : day) +
        "-" + ((month < 10) ? "0" + month : month) +
        "-" + ((year < 10) ? "0" + year : year) +
        " " + ((hour < 10) ? "0" + hour : hour) +
        ":" + ((minutes < 10) ? "0" + minutes : minutes) +
        ":" + ((seconds < 10) ? "0" + seconds : seconds) +
        "." + ("00" + milliseconds).slice(-3) + "] ";
    }
    log.apply(console, [formatConsoleDate(new Date()) + first_parameter].concat(other_parameters));
}

var config = JSON.parse(fs.readFileSync("config.json"));
var client = new SteamUser({
        enablePicsCache: true
    });
var ownedSubs = [];
var freeApps = config.free_apps == null ? false : config.free_apps;
var unwantedAppTypes = config.unwanted_app_types == null ? [] : config.unwanted_app_types;
var online = config.online == null ? true : config.online;
var cacheState = false;
var idsFile = __dirname+"/ids.txt";

if (config.winauth_usage) {
    SteamAuth.Sync(function(error) {
        if (error)
            console.log(JSON.stringify(error));
        var auth = new SteamAuth(config.winauth_data);
        auth.once("ready", function() {
            config.steam_credentials.authCode = config.steam_credentials.twoFactorCode = auth.calculateCode();
            steamLogin();
        });
    });
} else {
    steamLogin();
}

function steamLogin() {
    config.steam_credentials.rememberPassword = true;
    client.logOn(config.steam_credentials);
    client.on("loggedOn", function(response) {
        console.log("Logged into Steam as " + client.steamID.getSteam3RenderedID());
        var state = SteamUser.EPersonaState.Online;
        if (!online) {
            state = SteamUser.EPersonaState.Offline;
        }
        client.setPersona(state);
    });
    client.on("error", function(error) {
        console.log(JSON.stringify(error));
    });
    client.on("accountLimitations", function(limited, communityBanned, locked, canInviteFriends) {
        var limitations = [];
        if (limited) {
            limitations.push("limited");
        }
        if (communityBanned) {
            limitations.push("community banned");
        }
        if (locked) {
            limitations.push("locked");
        }
        if (limitations.length === 0) {
            console.log("Our account has no limitations");
        } else {
            console.log("Our account is " + limitations.join(", "));
        }
        if (canInviteFriends) {
            console.log("Our account can invite friends");
        }
    });
    client.on("vacBans", function(numBans, appids) {
        console.log("We have " + numBans + " VAC ban" + numberEnding(numBans.length));
        if (appids.length > 0) {
            console.log("We are VAC banned from app" + numberEnding(appids.length) + ": " + appids.join(", "));
        }
    });
    client.on("webSession", function(sessionID, cookies) {
        if (cacheState) {
            return;
        }
        fs.readFile(idsFile, function (err, fileData) {
            if (err || !isValidFileData(fileData)) {
                console.log("Got web session");
                var community = new SteamCommunity();
                community.setCookies(cookies);
                community.httpRequestGet("https://steamcommunity.com/openid/login?openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup&openid.realm=https%3A%2F%2Fsteamdb.info%2F&openid.return_to=https%3A%2F%2Fsteamdb.info%2Flogin%2F", {
                    followAllRedirects: true
                }, function(error, response, data) {
                    if (error) {
                        console.log(JSON.stringify(error));
                    }
                    var url = $("#openidForm", data).attr("action");
                    var formdata = $("#openidForm", data).serializeObject();
                    community.httpRequestPost(url, {
                        followAllRedirects: true,
                        formData: formdata
                    }, steamdbLogin);
                });
            } else {
                console.log("Restoring state....");
                console.log("Resume requesting apps....");
                var requestAppsState = JSON.parse(fileData.toString());
                freeApps = requestAppsState.freeApps;
                requestFreeSubs(requestAppsState.ids);
            }
        });
    });
    client.on("licenses", function(licenses) {
        console.log("Our account owns " + licenses.length + " license" + numberEnding(licenses.length));
    });
    client.on("appOwnershipCached", function() {
        console.log("Cached app ownership");
        if (cacheState) {
            return;
        }
        cacheState = true
        if (freeApps) {
            ownedSubs = client.getOwnedApps();
            ownedString = " app";
        } else {
            ownedSubs = client.getOwnedPackages()
            ownedString = " package"
        }
        console.log("Our account owns " + ownedSubs.length + ownedString + numberEnding(ownedSubs.length));
    });
}

function steamdbLogin(error, response, data) {
    console.log("Attempting to login to SteamDB")
    if (error) {
        console.log(JSON.stringify(error));
        CloudScraper.request({
            url: response.request.href,
            method: "GET"
        }, steamdbLogin);
    } else {
        var jar = request.jar();

        if (typeof response.headers["set-cookie"] != 'undefined') {
            response.headers["set-cookie"].forEach(function(cookiestr) {
                var cookie = request.cookie(cookiestr);
                jar.setCookie(cookie, "https://steamdb.info/");
            });
        }

        var m_url = "https://steamdb.info/search/?a=app_keynames&type=-1&keyname=243&operator=3&keyvalue=1";
        if (!freeApps) {
            m_url = "https://steamdb.info/search/?a=sub_keynames&keyname=1&operator=3&keyvalue=12";
        }

        CloudScraper.request({
            url: m_url,
            method: "GET",
            jar: jar
        }, function(error, response, data) {
            if (error) {
                console.log(JSON.stringify(error));
            } else {

                console.log("Processing.....");

                var freeSubs = [];
                if (freeApps) {
                    $("#table-sortable tr.app", data).each(function() {
                        var appType =  $("td", this)[1].textContent.trim();
                        var appId = $("td", this)[0].textContent.trim();
                        if (!unwantedAppTypes.includes(appType)) {
                            freeSubs.push(parseInt(appId));
                        } else {
                            // Uncomment the lines below if you want to see the unwanted apps
                            // var appName = $("td", this)[2].textContent.trim();
                            // console.log("Unwanted app: " + appName + " (" + appId + ")");
                        }
                    });
                } else {
                    $("#table-sortable tr.package", data).each(function() {
                        var wantedPackage = true;
                        var packageId = $("td", this)[0].textContent;
                        var packageName = $("td", this)[1].textContent;

                        var splitPackage = packageName.split(" ");
                        splitPackage.reverse();
                        splitPackage.forEach(function(item, index) {
                            if (unwantedAppTypes.includes(item.trim())) {
                                // Uncomment the line below if you want to see the unwanted packages
                                // console.log("Unwanted package: " + packageName + " (" + packageId + ")");
                                wantedPackage = false;
                                return;
                            }
                        });
                        if (wantedPackage) {
                            freeSubs.push(parseInt(packageId.trim()));
                        }
                    });
                }
                var ownedSubsPromise = setInterval(function() {
                        if (ownedSubs.length > 0) {
                            clearInterval(ownedSubsPromise);
                            var unownedFreeSubs = $(freeSubs).not(ownedSubs).get().sort(sortNumber);
                            console.log("Found " + freeSubs.length + " free sub" + numberEnding(freeSubs.length) + " of which " + unownedFreeSubs.length + " are not owned by us yet");
                            if (freeSubs.length === 0 && cacheState) {
                                console.log("Exiting....");
                                process.exit(0);
                            }
                            requestFreeSubs(unownedFreeSubs);
                        }
                    }, 10);
            }
        });
    }
}

function sortNumber(a,b) {
    return b - a;
}

function requestFreeSubs(unownedFreeSubs) {
    if (unownedFreeSubs.length > 0) {
        var subsToAdd = unownedFreeSubs.slice(0, config.max_subs);
        console.log("Attempting to request " + subsToAdd.length + " subs (" + subsToAdd.join() + ")");
        client.requestFreeLicense(subsToAdd, function(error, grantedPackages, grantedAppIDs) {
            if (error) {
                console.log(error)
            } else {
                if (grantedPackages.length === 0) {
                    console.log("No new packages were granted to our account");
                } else {
                    console.log(grantedPackages.length + " New package" + numberEnding(grantedPackages.length) + " (" + grantedPackages.join() + ") were successfully granted to our account");
                }
                if (grantedAppIDs.length === 0) {
                    console.log("No new apps were granted to our account");
                } else {
                    console.log(grantedAppIDs.length + " New app" + numberEnding(grantedAppIDs.length) + " (" + grantedAppIDs.join() + ") were successfully granted to our account");
                }
                console.log("Waiting " + millisecondsToStr(config.delay) + " for a new attempt");

                setTimeout(function() {
                    var nextUnownedFreeSubs = $(unownedFreeSubs).not(subsToAdd).get();
                    saveState(nextUnownedFreeSubs);
                    requestFreeSubs(nextUnownedFreeSubs);
                }, config.delay);
            }
        });
    } else {
        console.log("\n\t\t\t\t Restarting...");
        if (freeApps) {
            console.log("Finish with free apps...");
            console.log("Starting with free on demand pakages...");
        } else {
            console.log("Finish with free on demand packages...");
            console.log("Starting with free apps...");
        }
        freeApps = !freeApps;
        ownedSubs = [];
        cacheState = false;
        client.relog();
    }
}

function isValidFileData(fileData) {
    try {
        if (Boolean(fileData)) {
            var data = JSON.parse(fileData.toString());
            return Boolean(data.ids) && Boolean(data.ids[0]);
        }
    } catch (err) {
        // Just in case
    }
    console.log("Invalid file state");
    return false;
}

function saveState(ids) {
    var requestAppsState = "{\"ids\": [" + ids + "], \"freeApps\": " + freeApps + "}"
    fs.writeFile(idsFile, requestAppsState, { flag: 'w' }, function(err) {
        if (err) {
            console.log(err);
        } else {
            console.log("Unowned Free Subs file saved");
        }
    });
}

function millisecondsToStr(milliseconds) {
    var temp = Math.floor(milliseconds / 1000);
    var years = Math.floor(temp / 31536000);
    if (years) {
        return years + ' year' + numberEnding(years);
    }
    var days = Math.floor((temp %= 31536000) / 86400);
    if (days) {
        return days + ' day' + numberEnding(days);
    }
    var hours = Math.floor((temp %= 86400) / 3600);
    if (hours) {
        return hours + ' hour' + numberEnding(hours);
    }
    var minutes = Math.floor((temp %= 3600) / 60);
    if (minutes) {
        return minutes + ' minute' + numberEnding(minutes);
    }
    var seconds = temp % 60;
    if (seconds) {
        return seconds + ' second' + numberEnding(seconds);
    }
    return 'less than a second';
}

function numberEnding(number) {
    return (number > 1) ? 's' : '';
}

$.fn.serializeObject = function() {
    var o = {};
    var a = this.serializeArray();
    $.each(a, function() {
        if (o[this.name] !== undefined) {
            if (!o[this.name].push) {
                o[this.name] = [o[this.name]];
            }
            o[this.name].push(this.value || "");
        } else {
            o[this.name] = this.value || "";
        }
    });
    return o;
};