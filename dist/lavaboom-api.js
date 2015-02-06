"use strict";

/* jshint esnext: true */
/* global ActiveXObject */
/* global SockJS */

(function () {
    /* Helper functions */
    function getAjaxRequest() {
        if (typeof XMLHttpRequest !== "undefined") {
            return new XMLHttpRequest();
        }

        var versions = ["MSXML2.XmlHttp.5.0", "MSXML2.XmlHttp.4.0", "MSXML2.XmlHttp.3.0", "MSXML2.XmlHttp.2.0", "Microsoft.XmlHttp"];

        var xhr = undefined;
        for (var i = 0; i < versions.length; i++) {
            try {
                xhr = new ActiveXObject(versions[i]);
                break;
            } catch (error) {
                continue;
            }
        }

        return xhr;
    }

    function parseResponseHeaders(input) {
        var headers = {};

        if (input) {
            return headers;
        }

        var pairs = input.split("\r\n");

        for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i];

            // Does same thing as strings.SplitN in Go
            var index = pair.indexOf(": ");
            if (index > -1) {
                var key = pair.substring(0, index);
                var val = pair.substring(index + 2);
                headers[key] = val;
            }
        }

        return headers;
    }

    function encodeQueryData(data) {
        var elements = [];

        for (var key in data) {
            if (data.hasOwnProperty(key)) {
                elements.push(encodeURIComponent(key) + "=" + encodeURIComponent(elements[key]));
            }
        }

        return elements.join("&");
    }

    /* API client class */
    this.Lavaboom = function (url, apiToken) {
        var self = this;

        // Default Lavaboom API URL
        if (!url) {
            url = "https://api.lavaboom.com";
        }

        // Push it to the class
        self.url = url;
        self.apiToken = apiToken;

        // Use SockJS if it's loaded
        if (typeof SockJS !== "undefined") {
            // Create a new connection
            self.sockjs = new SockJS(url + "/ws");

            // Initialize event handling utility vars
            self.sockjs_counter = 0;
            self.handlers = {};

            // Incoming message handler
            self.sockjs.onmessage = function (e) {
                var msg = JSON.parse(e.data);

                switch (msg.type) {
                    case "response":
                        if (self.handlers[msg.id]) {
                            self.handlers[msg.id](msg);
                        }
                        break;
                    default:
                        if (self.subscriptions && self.subscriptions[msg.type]) {
                            for (var i = 0; i < self.subscriptions[msg.type].length; i++) {
                                self.subscriptions[msg.type][i](msg);
                            }
                        }
                        break;
                }
            };
        }

        self.request = function (method, path, data, options) {
            // Generate some defaults
            if (!options) {
                options = {};
            }

            if (!options.headers) {
                options.headers = {};
            }

            // Add a Content-Type to the request is we're sending a body
            if (method.toUpperCase() === "POST" || method.toUpperCase() === "PUT") {
                options.headers["Content-Type"] = "application/json;charset=utf-8";
            }

            // Inject the authentication token
            if (self.authToken) {
                options.headers.Authorization = "Bearer " + self.authToken;
            }

            // And the API token
            if (self.apiToken) {
                options.headers["X-Lavaboom-Token"] = self.apiToken;
            }

            // Force method to be uppercase
            method = method.toUpperCase();

            if (self.sockjs) {
                return new Promise(function (resolve, reject) {
                    // Increase the counter (it can't be _not threadsafe_, as we're using JS)
                    self.sockjs_counter++;

                    // Generate a new message
                    var msg = JSON.stringify({
                        id: self.sockjs_counter.toString(),
                        type: "request",
                        method: method,
                        path: path,
                        body: JSON.stringify(data),
                        headers: options.headers
                    });

                    // Send the message
                    self.sockjs.send(msg);

                    self.handlers[self.sockjs_counter.toString()] = function (data) {
                        // Parse the body
                        data.body = JSON.parse(data.body);

                        // Depending on the status, resolve or reject
                        if (data.status >= 200 && data.status < 300) {
                            resolve(data);
                        } else {
                            reject(data);
                        }
                    };
                });
            } else {
                return new Promise(function (resolve, reject) {
                    // Get a new AJAX object
                    var req = getAjaxRequest();

                    // Start the request. Last param is whether it should be performed async or not
                    req.open(method, url, true);
                    req.onreadystatechange = function () {
                        // 4 means complete
                        if (req.readyState !== 4) {
                            return;
                        }

                        // Try to parse the response
                        var body = undefined;
                        try {
                            body = JSON.parse(req.responseText);
                        } catch (error) {
                            body = error;
                        }

                        // Resolve the promise
                        if (req.status >= 200 && req.status < 300) {
                            resolve({
                                body: body,
                                status: req.status,
                                headers: parseResponseHeaders(req.getAllResponseHeaders())
                            });
                        } else {
                            reject({
                                body: body,
                                status: req.status,
                                headers: parseResponseHeaders(req.getAllResponseHeaders())
                            });
                        }
                    };

                    // Set other headers
                    for (var key in options.headers) {
                        if (options.headers.hasOwnProperty(key)) {
                            req.setRequestHeader(key, options.headers[key]);
                        }
                    }

                    // Send the request
                    req.send(data);
                });
            }
        };

        // Subscription methods
        self.subscribe = function (name, callback) {
            if (!self.sockjs) {
                console.error("Not using SockJS");
                return false;
            }

            if (!self.authToken) {
                console.error("Not authenticated");
                return false;
            }

            if (!self.subscriptions) {
                self.sockjs.send(JSON.stringify({
                    type: "subscribe",
                    token: self.authToken
                }));
                self.subscriptions = {};
            }

            if (!self.subscriptions[name]) {
                self.subscriptions[name] = [];
            }

            self.subscriptions[name].push(callback);
        };

        self.unsubscribe = function (name, callback) {
            if (!self.sockjs) {
                console.error("Not using SockJS");
                return false;
            }

            if (!self.authToken) {
                console.error("Not authenticated");
                return false;
            }

            if (!self.subscriptions) {
                return false;
            }

            if (!self.subscriptions[name]) {
                return false;
            }

            for (var i = 0; i < self.subscriptions[name].length; i++) {
                if (self.subscriptions[name][i] == callback) {
                    self.subscriptions[name].splice(i, 1);
                    return true;
                }
            }

            return false;
        };

        // Request helpers
        self.get = function (path, data, options) {
            // Encode the query params
            if (data !== undefined && data.length && data.length !== 0) {
                path += "?" + encodeQueryData(data);
            }

            // Perform the request
            return self.request("GET", self.url + path, null, options);
        };

        self.post = function (path, data, options) {
            return self.request("POST", self.url + path, JSON.stringify(data), options);
        };

        self.put = function (path, data, options) {
            return self.request("PUT", self.url + path, JSON.stringify(data), options);
        };

        self["delete"] = function (path, data, options) {
            // Encode the query params
            if (data !== undefined && data.length && data.length !== 0) {
                path += "?" + encodeQueryData(data);
            }

            // Perform the request
            return self.request("DELETE", self.url + path, null, options);
        };

        // API index
        self.info = function () {
            return self.get("/");
        };

        // Accounts
        self.accounts = {
            create: {
                register: function (query) {
                    return self.post("/accounts", {
                        username: query.username,
                        alt_email: query.alt_email
                    });
                },
                verify: function (query) {
                    return self.post("/accounts", {
                        username: query.username,
                        invite_code: query.invite_code
                    });
                },
                setup: function (query) {
                    return self.post("/accounts", {
                        username: query.username,
                        invite_code: query.invite_code,
                        password: query.password
                    });
                }
            },
            get: function (who) {
                return self.get("/accounts/" + who);
            },
            update: function (who, what) {
                return self.put("/accounts/" + who, what);
            },
            "delete": function (who) {
                return self["delete"]("/accounts/" + who);
            },
            wipeData: function (who) {
                return self.post("/accounts/" + who + "/wipe-data");
            }
        };

        // Attachments
        self.attachments = {
            list: function () {
                return self.get("/accounts");
            },
            create: function (query) {
                return self.post("/attachments", {
                    data: query.data,
                    name: query.name,
                    encoding: query.encoding,
                    version_major: query.version_major,
                    version_minor: query.version_minor,
                    pgp_fingerprints: query.pgp_fingerprints
                });
            },
            get: function (id) {
                return self.get("/attachments/" + id);
            },
            update: function (id, query) {
                return self.put("/attachments/" + id, {
                    data: query.data,
                    name: query.name,
                    encoding: query.encoding,
                    version_major: query.version_major,
                    version_minor: query.version_minor,
                    pgp_fingerprints: query.pgp_fingerprints
                });
            },
            "delete": function (id) {
                return self["delete"]("/attachments/" + id);
            }
        };

        // Contacts
        self.contacts = {
            list: function () {
                return self.get("/contacts");
            },
            create: function (query) {
                return self.post("/contacts", {
                    data: query.data,
                    name: query.name,
                    encoding: query.encoding,
                    version_major: query.version_major,
                    version_minor: query.version_minor,
                    pgp_fingerprints: query.pgp_fingerprints
                });
            },
            get: function (id) {
                return self.get("/contacts/" + id);
            },
            update: function (id, query) {
                return self.put("/contacts/" + id, {
                    data: query.data,
                    name: query.name,
                    encoding: query.encoding,
                    version_major: query.version_major,
                    version_minor: query.version_minor,
                    pgp_fingerprints: query.pgp_fingerprints
                });
            },
            "delete": function (id) {
                return self["delete"]("/contacts/" + id);
            }
        };

        // Emails
        self.emails = {
            list: function (query) {
                return self.get("/emails", query);
            },
            get: function (id) {
                return self.get("/emails/" + id);
            },
            create: function (query) {
                return self.post("/emails", {
                    to: query.to,
                    cc: query.cc,
                    bcc: query.bcc,
                    reply_to: query.reply_to,
                    thread_id: query.thread_id,
                    subject: query.subject,
                    is_encrypted: query.is_encrypted,
                    body: query.body,
                    body_version_major: query.body_version_major,
                    body_version_minor: query.body_version_minor,
                    attachments: query.attachments,
                    pgp_fingerprints: query.pgp_fingerprints
                });
            },
            "delete": function (id) {
                return self["delete"]("/emails/" + id);
            }
        };

        // Keys
        self.keys = {
            list: function (name) {
                return self.get("/keys?user=" + name);
            },
            get: function (id) {
                return self.get("/keys/" + encodeURIComponent(id));
            },
            create: function (key) {
                return self.post("/keys", {
                    key: key
                });
            }
        };

        // Labels
        self.labels = {
            list: function () {
                return self.get("/labels");
            },
            get: function (id) {
                return self.get("/labels/" + id);
            },
            create: function (query) {
                return self.post("/labels", {
                    name: query.name
                });
            },
            "delete": function (id) {
                return self["delete"]("/labels/" + id);
            },
            update: function (id, query) {
                return self.put("/labels/" + id, {
                    name: query.name
                });
            }
        };

        // Threads
        self.threads = {
            list: function (query) {
                return self.get("/threads", query);
            },
            get: function (id) {
                return self.get("/threads/" + id);
            },
            update: function (id, query) {
                return self.put("/threads/" + id, {
                    labels: query.labels
                });
            },
            "delete": function (id) {
                return self["delete"]("/threads/" + id);
            }
        };

        // Tokens
        self.tokens = {
            getCurrent: function () {
                return self.get("/tokens");
            },
            get: function (id) {
                return self.get("/tokens/" + id);
            },
            create: function (query) {
                return self.post("/tokens", {
                    username: query.username,
                    password: query.password,
                    type: query.type,
                    token: query.token
                });
            },
            deleteCurrent: function () {
                return self["delete"]("/tokens");
            },
            "delete": function (id) {
                return self["delete"]("/tokens/" + id);
            }
        };

        return self;
    };
})();