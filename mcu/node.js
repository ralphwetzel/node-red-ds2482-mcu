/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-ds2482-mcu
    License: MIT
*/

import { Node } from "nodered";
import { DS2482 } from "ds2482";
import I2C from "embedded:io/i2c";
import Timer from "timer";
import platform_config from "mc/config";

let _lock = false;

class DS2482Node extends Node {

  #controller;
  #mode;
  #paths; // Array!

  static type = "ds2482";

  #timer;

  #status(fill, shape, text, timeout) {

    let self = this;

    fill ??= "";
    shape ??= "";
    timeout ??= 3000;

    if (!text) {
      self.status({});
      return;
    }

    if (self.#timer) {
      Timer.clear(self.#timer);
      self.#timer = undefined;
    }

    self.status({ "fill": fill, "shape": shape, "text": text });
    self.#timer = Timer.set(function () {
      Timer.clear(self.#timer);
      self.#timer = undefined;
      self.status({});
    }, timeout);
  }

  onStart(config) {
    super.onStart(config);

    this.#status("grey", "dot", "Idle");

    this.#mode = config.mode;
    this.#paths = config.paths;
    this.#controller = RED.nodes.getNode(config.controller);

  }

  onMessage(msg, done) {

    function isObjectNeitherArrayOrFunction(val) {
      if (val === null) { return false;}
      return ((Array.isArray(val) === false) 
        && (typeof val !== 'function')
        && (typeof val === 'object')
        );
    }

    trace(this.id + ": " + (msg?.topic?.length > 0 ? msg.topic : this.#paths) + "\n");

    msg["ds2482"] ??= [];
    let log = msg["ds2482"];
    
    let self = this;

    self.#status("blue", "dot", "Processing...", 5000);

    let path = (msg.topic && (isObjectNeitherArrayOrFunction(msg.topic) || msg.topic.length > 0)) ?
        msg.topic : this.#paths;

    let data = msg?.payload;
    let ds = this.#controller.ds;
    let mode = msg.mode ?? this.#mode;

    let runner;

    trace("Object? " + isObjectNeitherArrayOrFunction(path) + "\n");

    if (mode === "read") {

      if (Array.isArray(path)) {

        trace("runner pathArray\n");

        // https://stackoverflow.com/questions/40328932/javascript-es6-promise-for-loop

        runner = pathArray => new Promise((resolve, reject) => {

          trace("in runner pathArray\n");

          let result = [];

          (function loop(i) {
            if (i >= pathArray.length) {
              trace("resolve runner pathArray\n");
              resolve(result);
              return;
            }
            trace(pathArray[i] + "\n");

            ds.readPath(pathArray[i])
            .then((r) => {
              trace("then runner pathArray\n");
              log.push({"path": pathArray[i], "read": r})
              result.push(r);
              loop(i+1);
            })
            .catch((err) => {
              reject(err);
              return;
            })
          })(0);

        });
      } else if (isObjectNeitherArrayOrFunction(path)) {

        trace("runner pathObject\n");

        runner = pathObject => new Promise((resolve, reject) => {

          trace("in runner pathObject\n");

          let result = {};
          let log = {};

          let keysArray = Object.keys(pathObject);

          (function loop(i) {
            if (i >= keysArray.length) {
              trace("resolve runner pathArray\n");
              resolve(result);
              return;
            }

            let k = keysArray[i];
            let p = pathObject[k];

            trace(`${k}: ${p}\n`);

            ds.readPath(p)
            .then((r) => {
              trace("then runner pathObject\n");
              
              log[k] = {"path": p, "read": r};
              result[k] = r;

              loop(i+1);
            })
            .catch((err) => {
              reject(err);
              return;
            })
          })(0);

        });

      } else {

        trace("runner pathSingle\n");

        runner = pathSingle => new Promise((resolve, reject) => {

          trace("in runner pathSingle\n");
          
          ds.readPath(pathSingle)
          .then((r) => {
            trace("then runner pathSingle\n");

            log.push({"path": pathSingle, "read": r});
            resolve(r);
            return;
          })
          .catch((err) => {
            reject(err);
            return;
          })

        });

      }

    } else if (mode === "write") {

      if (Array.isArray(path)) {

        // https://stackoverflow.com/questions/40328932/javascript-es6-promise-for-loop
        runner = (pathArray, dataArray) => new Promise((resolve, reject) => {

          let result = [];

          (function loop(i) {
            if (i >= pathArray.length) {
              resolve(result);
              return;
            }

            let v;

            if (Array.isArray(dataArray)) {
              if (i < dataArray.length) {
                v = dataArray[i];
              }
            } else {
              v = dataArray;
            }              

            trace("write - dataArray: index-> " + i + " | value-> " + v + "\n");

            if (typeof v !== 'undefined') {
              ds.writePath(pathArray[i], v)
              .then((r) => {
                log.push({"path": pathArray[i], "write": v, "result": r});
                result.push(r);
                loop(i+1);
              })
              .catch((err) => {
                reject(err);
                return;
              })
            } else {
              result.push(undefined);
              // this is a bit riscy - as blocking for huge pathArray.length
              loop(i+1);
            }
          })(0);

        });
      } else if (isObjectNeitherArrayOrFunction(path)) {

        // https://stackoverflow.com/questions/40328932/javascript-es6-promise-for-loop
        runner = (pathObject, dataArray) => new Promise((resolve, reject) => {

          let result = {};
          let log = {};

          let keysArray = Object.keys(pathObject);

          (function loop(i) {
            if (i >= keysArray.length) {
              resolve(result);
              return;
            }

            let v;

            if (Array.isArray(dataArray)) {
              if (i < dataArray.length) {
                v = dataArray[i];
              }
            } else {
              v = dataArray;
            }              

            trace(v + "\n");

            let k = keysArray[i];
            let p = pathObject[k];

            trace(k + " " + p + "\n");

            // trace("write - dataArray: index-> " + i + " | value-> " + v + "\n");

            if (typeof v !== 'undefined') {
              ds.writePath(p, v)
              .then((r) => {
                
                log[k] = {"path": p, "write": v, "result": r};
                result[k] = r;
  
                loop(i+1);
              })
              .catch((err) => {
                trace(err.toString() + "\n");
                reject(err);
                return;
              })
            } else {
              result[k] = undefined;
              // this is a bit riscy - as blocking for huge pathArray.length
              loop(i+1);
            }
          })(0);

        });

      } else if (Array.isArray(data)) {

        runner = (pathSingle, dataArray) => new Promise((resolve, reject) => {

          let result = [];

          (function loop(i) {
            if (i >= dataArray.length) {
              resolve(result);
              return;
            }
            ds.writePath(pathSingle, dataArray[i])
            .then((r) => {
              result.push(r);
              log.push({"path": pathSingle, "write":  dataArray[i], "result": r});
              loop(i+1);
            })
            .catch((err) => {
              reject(err);
              return;
            })  
          })(0);

        });

      } else {
        runner = (pathSingle, dataSingle) => new Promise((resolve, reject) => {

          ds.writePath(pathSingle, dataSingle)
          .then((r) => {
            log.push({"path": pathSingle, "write":  dataSingle, "result": r});
            resolve(r);
            return;
          })
          .catch((err) => {
            reject(err);
            return;
          })
        });
      }
    } else {

      trace.left(JSON.stringify({
        "error": {
          "error": `Wrong mode requested: "${mode}".`
        }
      }), self.id);
      return;

    }

    runner(path, data)
    .then((result) => {

      this.#status("grey", "dot", "Idle");
      // trace(this.id + ": " + (msg?.topic?.length > 0 ? msg.topic.toString() : this.#paths.toString()) + "*** END \n");
      
      msg.payload = result;
      this.send(msg);
      done();
    })
    .catch((err) => {

      this.#status("red", "dot", "Error");

      trace.left(JSON.stringify({
        "error": {
          "error": err.toString()
        }
      }), self.id);
      done(err);
    });

    return;

  }

  onCommand(options) {
    let self = this;

    if ("search" === options.command) {
      let msg = {}
      msg.cmd = "search";
      self.#controller?.receive(msg);
    }

  }

  static {
    RED.nodes.registerType(this.type, this);
  }
}

class DS2482Controller extends Node {
  #ds;

  static type = "ds2482controller";

  run(f) {
    try {
      return f();
    }
    catch (err) {
      trace.left(JSON.stringify({
        "error": {
          "error": err.toString()
        }
      }), this.id);
    }
  }

  onStart(config) {
    super.onStart(config);

    const options = {
      data: config.data,
      clock: config.clock,
      hz: config.hz,
      stop: true,
      // timeout: 50,
      address: config.address
    };

    return new Promise((resolve) => {

      // let i2c = new I2C(options);
      // this.#ds = new DS2482(i2c);

      let async = platform_config?.i2c?.async ?? false;
      let i2c = async ? new I2C.Async(options) : new I2C(options);
      this.#ds = new DS2482(i2c, async);

      this.#ds.init().then(() =>{
        trace("@controllerOnStart\n")
        return this.#ds.configureBridge({
          activePullup: true
        }).then(() => {
          trace("@controllerOnStart Done\n")
          resolve();
        })  
      })
      .catch((err) => {
        trace.left(JSON.stringify({
          "error": {
            "error": err.toString()
          }
        }), this.id);
        resolve();
      })
    })
  }

  onMessage(msg, done) {
    if (msg?.cmd == "search") {

      let self = this;

      self.#ds.paths
      .then((res) => {

        trace("paths: " + res + "\n");

        if (res) {
          // Feed back to the editor.
          trace.left(JSON.stringify({
            input: {
              cmd: "path_update",
              stamp: Math.round(Date.now() / 1000),
              paths: res
            }
          }), self.id);
        }
        // done();
      })
      .catch ((err) => {
        trace("path: Error!\n")
        trace.left(JSON.stringify({
          "error": {
            "error": err.toString()
          }
        }), this.id);
        // done();
      });
    }
  }

  get ds() {
    return this.#ds;
  }

  static {
    RED.nodes.registerType(this.type, this);
  }

}