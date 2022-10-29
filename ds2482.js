/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-DS2482-mcu
    License: MIT
*/

module.exports = function(RED) {
    "use strict";

    const fs = require('fs-extra');
    const path = require("path");
    
    function DS2482Node(n) {

        // currently no functionality for the non-MCU mode
        RED.nodes.createNode(this,n);
        let node = this;

    }
    RED.nodes.registerType("ds2482", DS2482Node);

    // This is the replacement node that will be invoked in MCU mode.
    function mcuDS2482Node(config) {
        RED.nodes.createNode(this, config);

        let node = this;
        node.controller = config.controller;

        node.search = function() {
            let proxy = node.__getProxy();
            if (proxy) {
                // hand search request over to MCU
                proxy.send2mcu("search", node.z, node.id);
                return true;
            }
            return false;
        }

    }
        
    RED.nodes.registerType("mcu*ds2482",mcuDS2482Node);
    if (typeof registerMCUModeType !== "undefined")
        registerMCUModeType("ds2482", "mcu*ds2482");


    let cache_dir = path.join(RED.settings.userDir, "ds2482-mcu-cache");
    fs.ensureDirSync(cache_dir);


    // Config nodes will not be replaced by the mcu-plugin!
    // Thus design the node to serve MCU as well as standard NR!
    function DS2482Controller(config) {

        RED.nodes.createNode(this,config);

        let node = this;

        node.on("input", function(msg, send, done) {

            if (msg?.cmd == "path_update") {

                let cache_data = {};
                let cache_file = path.join(cache_dir, "cache" + node.id + ".json");
                fs.ensureFileSync(cache_file);

                cache_data["id"] = node.id;

                if (msg.stamp) {
                    cache_data["stamp"] = msg.stamp;
                }
                if (msg.paths) {
                    cache_data["paths"] = msg.paths;
                }

                let cd = JSON.stringify(cache_data);
                fs.writeFile(cache_file, cd, err => {
                    if (err) {
                        RED.log.warn("node-red-DS2482-mcu: Failed to persist to cache @ " + cache_file);
                    }
                })
                
                RED.comms.publish("ds2482/pathupdate", cd, false);

            }
            done();
            return;
        })

    }
    RED.nodes.registerType("ds2482controller", DS2482Controller);

    RED.httpAdmin.get("/ds2482/search", function(req, res) {

        let id = req.query?.id;
        let ctrl_id = req.query?.controller;

        if (!id) {
            return res.status(400).send({
                'error': "Missing 'id' parameter in query string"
            });
        } else if (!ctrl_id) {
            return res.status(400).send({
                'error': "Missing 'controller' parameter in query string"
            });
        }

        // read the cached path data
        let cache_file = path.join(cache_dir, "cache" + ctrl_id + ".json");
        fs.ensureFileSync(cache_file);

        let cache_data;
        try {
            cache_data = fs.readFileSync(cache_file, 'utf8');
        } catch {}
        
        cache_data = (cache_data.length > 0) ? cache_data : "{}";

        try {
            cache_data = JSON.parse(cache_data) || {};
        } catch {}

        cache_data ??= {};

        let node = RED.nodes.getNode(req.query.id);
        
        // this issues a path update!
        cache_data["updating"] = (node?.search?.() === true);

        res.status(200).send(cache_data);

    });

}
