'use strict';

var fs    = require('fs'),
    util  = require('util'),
    path  = require('path'),
    spawn = require('child_process').spawn,
    im    = require('imagemagick'),
    utils = require('./tools/utils');

var Zeno = function (app, server, io, params) {
    this.app           = app;
    this.io            = io;
    this.server        = server;

    // --log
    this.logFile       = params.log;

    // --file
    this.pageFile      = params.file || 'pages.json';

    // --cookie
    this.cookieFile    = params.cookie || 'cookies.json';

    // --folder
    this.dir           = params.folder || 'screenshots';

    // --engine
    this.engine        = require('./tools/engine').get(params.engine);

    // --startAction
    this.startAction   = params.startAction || false;

    this.log           = utils.log;
    this.devices       = ['desktop', 'tablet', 'mobile'];
    this.phantomScript = path.join(__dirname, 'phantomScript.js');
    this.ext           = '.png'; // default extension
    this.instance      = [];     // list of environments
    this.cookiesList   = [];     // list of available cookies
    this.modules       = [];     // list of loaded modules
    this.listtoshot    = [];     // current queue
    this.versions      = [];     // list of detected versions
    this.results       = {};     // last version results
    this.pages         = {};     // model

    this.emitter = new (require('events').EventEmitter)();
    this.emitter.setMaxListeners(200);
};

Zeno.prototype = {
    /*
     * Initialize the app and fetch configuration
     * @param cb end initialization callback
     */
    init: function(cb) {
        var self = this;

        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir);
        }

        if (this.logFile) {
            var logFile   = fs.createWriteStream(this.logFile, {flags : 'a'});
            var logStdout = process.stdout;

            // copy stdout in the log file
            console.log = function(d) {
                logFile.write(util.format(d) + '\n');
                logStdout.write(util.format(d) + '\n');
            };
        }

        // Init results object
        this.devices.forEach(function(device) {
            self.results.engine = self.engine.name;
            self.results[device]         = {};
            self.results[device].results = [];
        });

        this.addCoreRoad();
        this.addListeners();
        this.addSocketIoListeners();

        this.log('Engine detected: ' + this.engine.name + ' ' + this.engine.version);

        // Fetch configuration file
        fs.readFile(this.pageFile, 'utf-8', function(err, file){
            if (err) {
                self.log('No file configuration founded');
            } else {
                self.pages            = JSON.parse(file);
                self.pages.refreshing = {
                    desktop: [],
                    tablet: [],
                    mobile: []
                };
                self.instance     = self.pages.envs;
            }

            if (self.pages.proxy) {
                self.log('Proxy detected: ' + self.pages.proxy);
            }

            self.updateVersionList();
            self.loadModules(cb);

            if (self.startAction) {
                self.devicesComparaison(self.instance[0], self.instance[1]);
            }
        });

        // Fetch cookies file
        fs.readFile(this.cookieFile, 'utf-8', function(err, file){
            if (err) { this.log(err); }
            else {
                self.cookiesList = JSON.parse(file);
            }
        });
    },

    /*
     * Create core express road
     */
    addCoreRoad: function () {
        var self = this;

        this.app.get('/', function(req, res) {
            res.render('index');
        });

        this.app.get('/update/:env', function(req, res) {
            self.instance.forEach(function (env) {
                if(env.alias === req.params.env) {
                    self.envScreenshot(env, 'desktop');
                    self.envScreenshot(env, 'mobile');
                    self.envScreenshot(env, 'tablet');
                }
            });
            res.send('Update ' + req.params.env + ' in progress\n');
        });

        this.app.get('/routes/:name', function(req, res) {
            res.render('routes/' + req.params.name);
        });

        this.app.get('/pages', function(req, res) {
            res.send(JSON.stringify(self.pages));
        });

        this.app.get('/queue', function(req, res) {
            res.send(JSON.stringify(self.listtoshot));
        });

        this.app.get('/versions', function(req, res) {
            res.send(JSON.stringify(self.versions));
        });

        this.app.get('/results', function(req, res) {
            res.send(JSON.stringify(self.results));
        });
        this.app.get('/results/:device', function(req, res) {
            res.send(JSON.stringify(self.results[req.params.device]));
        });

        this.app.get('/log', function(req, res) {
            if (self.logFile) {
                fs.readFile(self.logFile, 'utf-8', function(err, file){
                    if (err) {self.log(err);}
                    var lines = file.trim().split('\n');

                    var log   = '';
                    var start = lines.length - 20 > 0 ? lines.length - 20 : 0;

                    for (var i = start; i < lines.length; i++) {
                        log += lines[i] + '<br/>';
                    }

                    res.send(log);
                });
            } else {
                res.send('log mode not activated');
            }
        });

        this.app.get('/compareall/:env1/:env2', function(req, res) {
            var env1, env2;
            for (var i = 0; i < self.instance.length; i++) {
                if (self.instance[i].alias === req.params.env1) {
                    env1 = self.instance[i];
                } else if (self.instance[i].alias === req.params.env2) {
                    env2 = self.instance[i];
                }
            }

            self.devicesComparaison(env1, env2);
            res.send('{status: "Comparaison started"}');
        });
    },

    /*
     * Attach core listeners
     */
    addListeners: function () {
        var self = this;
        this.on('takeScreenshot', function (data) {
            //check for fallbacks
            if(typeof data.options.device === 'undefined') {
                data.options.device = 'desktop';
            }

            if(typeof data.options.env === 'undefined') {
                data.options.env = '';
            }

            self.takeScreenshot(data.url, data.path, data.options);
        });

        /*
         * @param data.device : device to render
         * @param data.env    : environment name
         * @param data.alias  : environment alias
        */
        this.on('onEnvUpdate', function (data){
            self.io.sockets.emit('queueChangeEvent', {
                size: self.listtoshot.length
            });

            var lastVersion = self.versions[self.versions.length - 1];

            // this env has not been updated yet, add it
            if (lastVersion[data.device].indexOf(data.alias) === -1) {
                lastVersion[data.device].push(data.alias);
            }
            // this env has already been updated but others are not
            // thus it's just an update
            else if (!self.isVersionComplete(lastVersion)) {
                self.start();
            } else { // last version is complete, add a new one
                self.addVersion();
            }
        });
    },

    /*
     * Attach core socket IO listeners
     */
    addSocketIoListeners: function () {
        var self = this;

        /*
         * SocketIO listeners
         */
        this.io.sockets.on('connection', function (socket) {
            /*
             * Fired when an image is refreshed by a client
             */
            socket.on('refreshOneScreen', function (data) {
                self.unitScreenshot(
                    self.instance[data.env],
                    data.name,
                    data.type,
                    socket
                );
            });

            /*
             * Fired when an environment is refreshed by a client
             */
            socket.on('refreshEnv', function (data) {
                self.envScreenshot(data.env, data.type, socket);
            });

            /*
             * Fired when user update the configuration from /settings
             */
            socket.on('updateModel', function (data) {
                self.devices.forEach(function (device){
                    data.list[device].forEach(function (url) {
                        delete url.percentage;
                    });
                });
                self.pages.desktop = data.list.desktop;
                self.pages.mobile  = data.list.mobile;
                self.pages.tablet  = data.list.tablet;
                self.instance      = self.pages.envs;
                self.pages.edited  = true;
            });

            /*
             * Fired after each client side comparaison to update the server object
             */
            socket.on('updateResults', function (data) {
                self.updateResultsByName(data.name, data.device, data.percentage);
            });

            socket.on('updateEngine', function (data) {
                self.engine       = require('./tools/engine').get(data.engine);
                self.pages.engine = self.engine.name;
                self.log('Engine updated : ' + self.engine.name + ' ' + self.engine.version);
            });

            socket.on('saveModel', function () {
                fs.writeFile('pages.json', JSON.stringify(self.pages), function (err) {
                    if (err) return self.log(err);
                    self.pages.edited = false;
                });
            });
        });
    },

    /*
     * Load modules
     * @param cb end initialization callback
     */
    loadModules: function (cb) {
        var self = this,
            name = 'modules';

        fs.readdir(name, function(err, dirs){
            if (err) {return self.log(err);}
            self.modules = dirs;

            self.modules.forEach(function(dir) {
                var module = require('./' + name + '/' + dir + '/' + dir);

                if (module.module) {
                    module.module(self.getWrapper());
                } else {
                    self.log('Module "' + dir + '" desactivated: no module Method');
                }
            });

            self.endInit();
            if(cb) {cb();}
        });
    },

    /*
     * finalize express configuration adn error handling
     */
    endInit: function () {
        var self = this;
        this.app.get('*', function(req, res, next) {
            self.log('Error 404 : ' + req.url);
            var err = new Error();
            err.status = 404;
            next(err);
        });

        /* Error handling */
        this.app.use(function(err, req, res, next){
            if(err.status !== 404) {
                return next();
            }

            res.status(404).render('404');
        });

        this.server.listen(this.app.get('port'), function(){
            self.log('Express server listening on port ' + self.app.get('port'));
        });
    },

    /*
     * Return a list of cookies value for a given page
     * @param page one page object of one device
     */
    getCookies: function (page) {
        var cookies = [];
        if (page.cookies) {
            for (var i = 0; i < page.cookies.length; i++) {
                if(this.cookiesList[page.cookies[i]]) {
                    cookies.push(this.cookiesList[page.cookies[i]]);
                }
            }
        }

        return cookies;
    },

    /*
     * Create a process to take screenshot and create a thumbnail using imagemagick
     * @param url     page url to capture
     * @param name    image name according to configuration
     * @param options engine options
     */
    takeScreenshot: function (url, name, options) {
        var p        = require('path'),
            self     = this,

            // last version path
            todayDir = p.join(this.dir, this.versions[this.versions.length - 1].name),
            // image path
            path     = p.join(todayDir, options.env +  name + this.ext);

        var args = [this.engine.ssl, this.phantomScript, JSON.stringify({
                ua          : options.userAgent,
                viewportSize: options.viewportSize,
                cookies     : options.cookies,
                blacklist   : self.pages.blacklist, // requests to exclude
                path        : path, // path on disk
                url         : url,  // use to render a page from url
                body        : options.body  // use to render a page from html
            })];

        if (this.pages.proxy) {
            args.splice(1, 0, '--proxy=' + this.pages.proxy);
        }

        var process = spawn(this.engine.path, args);

        process.stdout.on('data', function(data) {
            var chunk = '' + data, // cast as a string
                metrics;

            try {
                metrics = JSON.parse(chunk);
                if (metrics.errors.length) {
                    self.log('Request error: ' + metrics.errors);
                }

            } catch(err) {
                self.log('Phantom Error:' + chunk);
            }

            self.emit('onScreenshotDone', {
                name   : name,
                options: options,
                metrics: metrics
            });
        });

        // exit callback
        process.on('exit', function(code) {
            if(code) {
                self.log('Error during ' + self.engine.name + ' exec: ' + code);
                return self.next();
            }

            self.log('(' + this.pid + ') update done: ' + path);

            // Create a thumbnail to reduce Ram blueprint on client
            im.resize({
                srcPath: path,
                dstPath: path.replace(self.ext, '_thumb.png'),
                height : 200
            }, function(err){
                if (err) {return console.warn(err);}

                // Push update url to each client
                self.io.sockets.emit('updateOneScreen', {
                    name: name,
                    env : options.env
                });

                self.next();
            });
        });
    },

    /*
     * Start the comparaison
     */
    start: function (argument) {
        this.takeScreenshot(
            this.listtoshot[0].url,
            this.listtoshot[0].name,
            this.listtoshot[0].options
        );
    },

    /*
     * Remove current element from the queue
     * and start the next one
     */
    next: function () {
        this.listtoshot.splice(0, 1);

        this.io.sockets.emit('queueChangeEvent', {
            size: this.listtoshot.length
        });

        if (this.listtoshot.length){
            this.start();
        } else {
            // Start comparaison if at least one environment has been updated
            if (this.pages.refreshing.desktop.length || this.pages.refreshing.tablet.length || this.pages.refreshing.mobile.length){
                this.devicesComparaison(this.instance[0], this.instance[1]);
            }

            // wait that everthing is finished before allowing the next refresh
            this.pages.refreshing = {
                desktop: [],
                tablet: [],
                mobile: []
            };
        }
    },

    /*
     * Refresh a whole environment for one device
     * @param env environment object
     * @param device device name
     */
    envScreenshot: function (env, device) {
        var server,
            cookies = [],
            self    = this,
            pages   = this.pages[device],
            details = {};

        if (device === 'mobile') {
            details.viewport = {width: 640, height: 1100};
            details.ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_1 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5376e Safari/8536.25';
        } else if (device === 'desktop') {
            details.viewport = {width: 1600, height: 1100};
            details.ua = 'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.36';
        } else if (device === 'tablet') {
            details.viewport = {width: 1024, height: 1100};
            details.ua = 'Mozilla/5.0 (iPad; CPU OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4';
        } else {
            return;
        }

        if (!utils.contains(this.pages.refreshing[device], env.server)) {
            this.log('Update ' + device + ' screenshots (' + env.server + ')');
            this.pages.refreshing[device].push(env.server);

            pages.forEach(function (page) {
                if (page.url) {
                    var alternative = undefined;
                    self.getCookies(cookies, page);

                    if (page.hasOwnProperty('alternative') && env.hasOwnProperty('alternative')) {
                        alternative = env.alternative[page.alternative];
                    }

                    var options = {
                        env          : env.server,
                        cookies      : cookies,
                        device       : device,
                        userAgent    : details.ua,
                        viewportSize : details.viewport
                    };

                    if (typeof alternative !== 'undefined'){
                        server = alternative;
                    } else {
                        server = env.server;
                    }

                    self.listtoshot.push({
                        url    : self.parseUrl(server, page.url, env.port),
                        name   : page.name,
                        options: options
                    });
                }
            });

            self.emit('onEnvUpdate', {
                device : device,
                env    : env.server,
                alias  : env.alias
            });
        } else {
            this.log('Refresh desktop already in progress: ' + env.server);
        }
    },

    /*
     * Refresh one version of one image
     * @param env environment object
     * @param name id of the page object
     * @param device device name
     */
    unitScreenshot: function (env, name, device) {
        var ua,
            width,
            server,
            url,
            alternative,
            cookies = [],
            height  = 1100;

        if(device === 'tablet') {
            ua = 'Mozilla/5.0 (iPad; CPU OS 4_3_5 like Mac OS X; en-us) AppleWebKit/533.17.9 (KHTML, like Gecko) Version/5.0.2 Mobile/8L1 Safari/6533.18.5';
            width = 1024;
        } else if(device === 'mobile') {
            ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5376e Safari/8536.25';
            width = 640;
        } else if(device === 'desktop') {
            ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/30.0.1599.114 Safari/537.36';
            width = 1600;
        } else {
            return;
        }

        for (var i = 0; i < this.pages[device].length; i++) {
            if (this.pages[device][i].name === name) {
                cookies = this.getCookies(this.pages[device][i]);

                if (this.pages[device][i].hasOwnProperty('alternative') && env.hasOwnProperty('alternative')) {
                    alternative = env.alternative[this.pages[device][i].alternative];
                }

                url = this.pages[device][i].url;

                break;
            }
        }

        this.log('Updating "' + name + '" for ' + device + '/' + env.alias);

        var options = {
            env        : env.server,
            userAgent  : ua,
            cookies    : cookies,
            device     : device,
            viewportSize :
                {width: width, height: height}
        };

        if (typeof alternative !== 'undefined'){
            server = alternative;
        } else {
            server = env.server;
        }

        var realUrl = this.parseUrl(server, url, env.port);

        this.listtoshot.push({
            url     : realUrl,
            name    : name,
            options : options
        });

        this.io.sockets.emit('queueChangeEvent', {
            size: this.listtoshot.length
        });

        // do not trigger update if it's already running, just queue it
        // and use the last version to update the image
        if(this.listtoshot.length === 1) {
            this.takeScreenshot(realUrl, name, options);
        }
    },

    /*
     * Add a new unique version, ie a folder on disk
     * @param cb callback function
     */
    addVersion: function(cb) {
        var self = this,
            d    = new Date();

        // directory name pattern : mm-dd-yyyy-hh:mm
        var newFolder = (d.getMonth() + 1)
            + '-' + d.getDate() + '-' + d.getFullYear()
            + '-' + d.getHours() + ':' + d.getMinutes();

        this.log('New version added: ', newFolder);

        fs.mkdir(newFolder, function (err){
            self.versions.push({
                name: newFolder,
                envs: []
            });

            self.io.sockets.emit('updateVersionEvent', {versions: self.versions});

            if(cb)
                cb();
        });
    },

    /*
     * Read versioning folder to update and sort the versions list
     */
    updateVersionList: function () {
        this.log('Fetch versions list');
        var self = this;
        fs.readdir(this.dir, function(err, dirs){
            if (err) { return self.log(err); }

            // fresh install
            if (dirs.length === 0) {
                return addVersion();
            }

            dirs.sort(function (a, b) {
                var as = a.split('-');
                var bs = b.split('-');

                // Compatibility with zeno 1.0
                if (as.length === 3 || bs.length === 3) {
                    var da = new Date(as[2], parseInt(as[0], 10) - 1, as[1]);
                    var db = new Date(bs[2], parseInt(bs[0], 10) - 1, bs[1]);
                } else if (as.length === 4 || bs.length === 4) {
                    var ha = as[3].split(':');
                    var da = new Date(as[2], parseInt(as[0], 10) - 1, as[1], ha[0], ha[1]);
                    var hb = bs[3].split(':');
                    var db = new Date(bs[2], parseInt(bs[0], 10) - 1, bs[1], hb[0], hb[1]);
                } else {
                    return -1; // folder in error
                }

                return da - db;
            });

            dirs.forEach(function(dir) {
                var envs = [];
                self.pages.envs.forEach(function (env){
                    envs.push(env.alias);
                });

                fs.readFile(path.join(self.dir, dir, 'status.json'), function (err, data) {
                    if (!err) {
                        var status = JSON.parse(data);
                    }
                    // else considere the version as full

                    self.versions.push({
                        name: dir,
                        desktop: envs,
                        tablet: envs,
                        mobile: envs
                    });
                });

            });
        });
    },

    isVersionComplete: function (version) {
        var length = this.instance.length;
        if(version.desktop.length === length && version.tablet.length === length && version.mobile.length === length) {
            return true;
        }
        return false;
    },

    /*
     * Return a valid http url to render
     * @param server property of environment object
     * @param url url to decode
     * @param port port number (optional)
     */
    parseUrl: function (server, url, port) {
        var decodeUrl;
        var host = this.pages.host.replace('{$alias}', server);

        if (port) {
            host += ':' + port;
        }

        decodeUrl = url.replace('$host', host);

        return decodeUrl;
    },

    /*
     * Update results list
     * @param name: image name described in configuration
     * @param device: device where the comparaison has been computed
     * @param percentage: result of the comparaison
     */
    updateResultsByName: function(name, device, percentage) {
        var found = false;

        for (var i = 0; i < this.results[device].results.length; i++) {
            var error = this.results[device].results[i];
            if (name === error.name) {
                found = true;

                if (percentage === '0.00') {
                    this.results[device].results.splice(i, 1);
                } else {
                    error.percentage = percentage;
                    this.results[device].date = new Date();
                }
                break;
            }
        }

        // new failure to add
        if (!found && percentage !== '0.00') {
            this.results[device].results.push({name: name, percentage: percentage});
            this.results[device].date = new Date();
        }
    },

    /*
     * Compare the whole set of images
     * @param env1: value of instance object
     * @param env2: value of instance object
     */
    devicesComparaison: function (env1, env2) {
        this.log('Comparaison started between: ' + env1.alias + '/' + env2.alias);

        var self = this;
        this.devices.forEach(function (device) {
            self.results[device].results = [];
            self.pages[device].forEach(function (page) {
                self.results[device].date  = new Date();

                var name = page.name;
                utils.compareImages(
                    path.join(self.dir, env1.server + name + self.ext),
                    path.join(self.dir, env2.server + name + self.ext),
                    function (percentage) {
                        self.updateResultsByName(name, device, percentage);
                    }
                );
            });
        });
    },

    on: function(ev, fn) {
        this.emitter.on(ev, fn);
    },

    emit: function(ev, fn) {
        this.emitter.emit(ev, fn);
    },

    getWrapper: function () {
        return {
            // configuration
            ext: this.ext,
            dir: this.dir,
            pages: this.pages,
            app: this.app,
            io: this.io,

            //log
            log: this.log,

            // events
            on: this.on.bind(this),
            emit: this.emit.bind(this)
        };
    }
};

exports = module.exports = Zeno;
