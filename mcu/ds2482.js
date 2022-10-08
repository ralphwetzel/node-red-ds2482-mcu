/*
    This code is based on DS2482 Onewire Bridge
    Copyright (c) 2017 Ian Metcalf
    https://github.com/ianmetcalf/node-ds2482
    License: MIT

    Adaptations to node-red-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-ds2482-mcu
    License: MIT
*/

'use strict';

import Modules from "modules";
import Timer from "timer";

// https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/tools/manifest.md#config
import config_from_manifest from "mc/config";

import { cmds } from "commands";
import { Buffer } from "buffer";
// import { trace } from "console";
//import { trace } from "console";

// import { trace } from "console";

// const utils = require('./utils');

const ROM_SIZE = 8;

const _utils = {
    checkCRC: function (buffer, length) {

        if (!(buffer instanceof Buffer)) {
            // eslint-disable-next-line no-param-reassign
            buffer = Buffer.from(Array.isArray(buffer) ? buffer : [buffer]);
        }

        length = length ?? buffer.length;

        let crc = 0;

        for (let i = 0; i < length; i += 1) {
            crc ^= buffer.readUInt8(i);

            for (let j = 0; j < 8; j += 1) {
                if (crc & 0x01) {
                    crc = (crc >> 1) ^ 0x8C;
                } else {
                    crc >>= 1;
                }
            }
        }

        return (crc === 0);
    },

    // delay: function (duration) {
    //     return new Promise(resolve => {
    //         setTimeout(() => {
    //             trace(duration + "\n");
    //             resolve();
    //         }, duration)
    //     })
    // }
}

const utils = Object.freeze(_utils);

// const owFamilyCode = {
//     "26": "ds2438"
// }

// The generic (= not implemented) 1-wire device
class owGeneric {
    paths = { "not_implemented": [] }
}

// class owDevice {

//     #id;
//     #paths = {};

//     add_path(name, read, write) {
//         if (name in this.#paths) {
//             throw new RangeError(`Path labeled "${name}" already exists.`)
//         }
//         this.#paths[name] = [read, write];
//     }

//     constructor(id) {
//         this.#id = id;
//     }

//     get id() {
//         return this.#id;
//     }

//     read(bridge, id, path) {
//         if (path in this.#paths) {
//             return this.#paths[path][0](bridge, id);
//         }
//     }

//     write(bridge, id, path, data) {
//         if (path in this.#paths) {
//             this.#paths[path][1](bridge, id, data);
//             return true;
//         }
//         return;
//     }

//     get paths() {
//         return Object.keys(this.#paths).sort();
//     }
// }


// class ds2438 extends owDevice {

//     static {
//         super.#add("temperature", function(bridge, id, path){}, function(bridge, id, path, data){})

//     }



// }




class DS2482 {

    /* the table to translate family codes to module names shall be defined in the
     * manifest.json:
     *  {
     *      config: {
     *          ds2482: {
     *              <family_code>: <module_name>
     *          }
     *      }
     *  }
     */
    #modules4devices = config_from_manifest?.ds2482?.devices;
    #modules = {};

    #devices = [];
    #workers = {};

    constructor(i2c) {
        // eslint-disable-next-line no-param-reassign
        // options = options || {};

        this.i2c = i2c;
        this.channel = null;
    }

    /*
     * Main API
     */

    init() {
        return this.reset();
    }

    reset() {
        this.lastFound = null;
        this.lastConflict = 0;

        this._resetBridge();
        return this._resetWire();
    }

    configureBridge(options, confirm) {
        // let config = 0;

        options ??= {};

        this._wait(true);
        this._i2cWrite(cmds.SET_READ_POINTER, [cmds.REGISTERS.CONFIG]);
        let config = this._i2cRead() & 0x0F;

        if (options.activePullup) {
            config = (config & ~cmds.CONFIG.ACTIVE) | ((options.activePullup ? 1 : 0) * cmds.CONFIG.ACTIVE)
        }
        if (options.strongPullup) {
            config = (config & ~cmds.CONFIG.STRONG) | ((options.strongPullup ? 1 : 0) * cmds.CONFIG.STRONG)
        }
        if (options.overdrive) {
            config = (config & ~cmds.CONFIG.OVERDRIVE) | ((options.overdrive ? 1 : 0) * cmds.CONFIG.OVERDRIVE)
        }

        this._i2cWrite(cmds.WRITE_CONFIG, [((~config & 0x0F) << 4) | config]);

        let resp;
        if (confirm) {
            resp = this._readBridge();
            if (config !== resp) {
                throw new Error('Failed to configure bridge');
            }
        }

        return resp;
    }

    strongPullup() {
        this.configureBridge({strongPullup: true});
    }

    selectChannel(num) {

        const ch = cmds.SELECTION_CODES[num || 0];
        if (!ch) {
            throw new Error('Invalid channel');
        }

        if (this.channel === num) {
            return ch.read;
        }

        this._wait(true);
        this.writeData(cmds.CHANNEL_SELECT, [ch.write]);
        let resp = this._readBridge();

        if (ch.read !== resp) {
            throw new Error('Failed to select channel');
        }

        this.channel = num;
        return resp;
    }

    sendCommand(cmd, rom) {
        rom ? this.matchROM(rom) : this.skipROM();
        this.writeData(cmd);
    }

    search() {
        this.lastFound = null;
        this.lastConflict = 0;

        const found = [];

        const searchNext = () => {
            let resp = this.searchROM();
            found.push(resp);

            if (this.lastConflict) {
                return searchNext();
            }

            this.lastFound = null;
            this.lastConflict = 0;

            return found;
        };

        return searchNext();
    }

    searchByFamily(family) {
        if (typeof family === 'string') {
            // eslint-disable-next-line no-param-reassign
            family = parseInt(family, 16);
        }

        this.lastFound = Buffer.from([family, 0, 0, 0, 0, 0, 0, 0]);
        this.lastConflict = 64;

        const found = [];

        const searchNext = () => {
            let resp = this.searchROM()

            if (this.lastFound.readUInt8(0) === family) {
                found.push(resp);
            }

            if (this.lastConflict > 7 && found.length) {
                return searchNext();
            }

            this.lastFound = null;
            this.lastConflict = 0;

            return found;
        };

        return searchNext();
    }

    /*
     * Onewire ROM API
     */

    searchROM() {
        const rom = Buffer.alloc(ROM_SIZE);

        let offset = 0;
        let mask = 0x01;
        let bit = 1;
        let lastConflict = 0;

        const direction = () => {
            if (this.lastFound && bit < this.lastConflict) {
                return this.lastFound.readUInt8(offset) & mask;
            }

            return bit === this.lastConflict ? 1 : 0;
        };

        const searchNextBit = () => {
            let d = direction();
            // trace("dir: " + d + "\n");

            let resp = this.triplet(d);

            const sbr = (resp & cmds.STATUS.SINGLE_BIT);
            const tsb = (resp & cmds.STATUS.TRIPLE_BIT);
            const dir = (resp & cmds.STATUS.BRANCH_DIR);

            // trace(resp + "\n");

            if (sbr && tsb) {
                throw new Error('Bad search result');
            }

            if (!sbr && !tsb && !dir) {
                lastConflict = bit;
            }

            const part = rom.readUInt8(offset);

            rom.writeUInt8(dir ? part | mask : part & ~mask, offset);

            mask <<= 1;
            bit += 1;

            if (mask > 128) {
                offset += 1;
                mask = 0x01;
            }

            if (offset < rom.length) {
                return searchNextBit();
            }

            if (rom[0] === 0) {
                throw new Error('ROM invalid');
            }

            if (!utils.checkCRC(rom)) {
                throw new Error('CRC mismatch');
            }

            this.lastFound = rom;
            this.lastConflict = lastConflict;

            return rom.toString('hex');

        };

        this._resetWire();
        this.writeData(cmds.ONE_WIRE_SEARCH_ROM);
        return searchNextBit();

    }

    readROM() {
        this._resetWire();
        this.writeData(cmds.ONE_WIRE_READ_ROM);
        let rom = this.readData(ROM_SIZE);

        if (rom[0] === 0) {
            throw new Error('ROM invalid');
        }

        if (!utils.checkCRC(rom)) {
            throw new Error('CRC mismatch');
        }

        return rom.toString('hex');
    }

    matchROM(rom) {
        // trace(rom + "\n");

        if (typeof rom === 'string') {
            // eslint-disable-next-line no-param-reassign
            rom = Buffer.from(rom, "hex");
        }

        if (rom[0] === 0 || rom.length !== ROM_SIZE) {
            throw new Error(`${rom}: ROM invalid.`);
        }

        this._resetWire();
        this.writeData(cmds.ONE_WIRE_MATCH_ROM);
        return this.writeData(rom);
    }

    skipROM() {
        this._resetWire();
        return this.writeData(cmds.ONE_WIRE_SKIP_ROM);
    }

    strongPullup
    /*
     * Onewire read/write API
     */

    writeData(data, length) {
        if (!(data instanceof Buffer)) {
            // eslint-disable-next-line no-param-reassign
            data = Buffer.from(Array.isArray(data) ? data : [data]);
        }

        length = length ?? data.byteLength;

        let offset = 0;

        const writeNextByte = () => {
            this._i2cWrite(cmds.ONE_WIRE_WRITE_BYTE, data.slice(offset, offset + 1));
            let resp = this._wait();

            offset += 1;
            if (offset < length) {
                return writeNextByte();
            }

            return resp;
        };

        this._wait(true);
        return writeNextByte();
    }

    readData(size) {
        const data = Buffer.alloc(size);

        let offset = 0;

        const readNextByte = () => {
            this._i2cWrite(cmds.ONE_WIRE_READ_BYTE);
            this._wait();
            let resp = this._readBridge(cmds.REGISTERS.DATA);

            data.writeUInt8(resp, offset);
            offset += 1;
            if (offset < data.length) {
                return readNextByte();
            }

            return data;
        }

        this._wait(true);
        return readNextByte();
    }

    bit(setHigh) {
        this._wait(true);
        this._i2cWrite(cmds.ONE_WIRE_SINGLE_BIT, [setHigh ? 0x80 : 0]);
        let resp = this._wait();
        return (resp & cmds.STATUS.SINGLE_BIT ? 1 : 0);
    }

    triplet(dir) {
        this._wait(true);
        this._i2cWrite(cmds.ONE_WIRE_TRIPLET, [dir ? 0x80 : 0]);
        return this._wait();

    }

    /*
     * Private Methods
     */

    _resetBridge() {
        this._i2cWrite(cmds.DEVICE_RESET);
        let resp = this._wait();
        this.channel = 0;
        return resp;
    }

    _resetWire() {

        this._wait(true);
        this._i2cWrite(cmds.ONE_WIRE_RESET);
        let resp = this._wait();

        // trace("_resetWire: " + JSON.stringify(resp) + "\n");

        if (resp & cmds.STATUS.SHORT) {
            throw new Error('Detected onewire short');
        }

        if (!(resp & cmds.STATUS.PRESENCE)) {
            throw new Error('Failed to detected any onewire devices');
        }

        return resp;
    }

    _wait(setPointer) {

        let reg = setPointer ? cmds.REGISTERS.STATUS : null;
        let resp;
        let t = Timer.set(() => {
            throw new Error('Wait timeout');
        }, 200);

        do {
            if (resp) {
                reg = null;
                Timer.delay(10);
            }
            try {
                resp = this._readBridge(reg);
            } catch (err) {
                Timer.clear(t);
                throw err;
            }
        } while (resp & cmds.STATUS.BUSY)

        Timer.clear(t);
        return resp;
    }

    _readBridge(reg) {
        if (reg) {
            this._i2cWrite(cmds.SET_READ_POINTER, [reg]);
        }

        let r = this._i2cRead();
        return ((r >>> 0) & 0xFF)
    }


    _i2cWrite(cmd, bytes) {

        // trace("write: " + cmd + ", " + JSON.stringify(bytes) + "\n");

        let args = [cmd];
        if (bytes) {
            if (Array.isArray(bytes)) {
                args = args.concat(bytes);
            } else if (bytes instanceof Buffer) {
                args = args.concat(...bytes);
            } else {
                throw new TypeError("'bytes' of _i2cWrite is of type " + typeof (bytes) + ".");
            }
        }

        // trace("write: " + JSON.stringify(Uint8Array.from(args)) + "\n");

        // from: Moddable/moddable/modules/io/expander/expander.js
        try {
            this.i2c.write(Uint8Array.from(args).buffer, true);
        } catch (e) {
            throw new Error("I2C: Write failed.", e.fileName, e.lineNumber);
        }
    }

    _i2cRead() {
        let res;
        try {
            res = new Uint8Array(this.i2c.read(1, true));
        } catch (e) {
            throw new Error("I2C: Read failed.", e.fileName, e.lineNumber);
        }
        // trace("read: " + JSON.stringify(res) + "\n");
        return res[0];
    }

    /*
        1-Wire device access API by path
     */

    // class generic {

    //     paths = {
    //         "not_implemented": []
    //     }

    // }

    #get_worker(family_code) {

        if (!this.#workers[family_code]) {

            // check if there's a module defined for this family code
            if (family_code in this.#modules4devices) {
                // if so: import it!
                this.#modules[family_code] = Modules.importNow(this.#modules4devices[family_code]);

                // invoke the default function
                this.#workers[family_code] = new this.#modules[family_code]()

            } else {
                // No device manager available to support this family code!
                if (!this.#modules['*generic*']) {
                    // create a single worker instance (and store this in #modules)!
                    this.#modules['*generic*'] = new owGeneric();
                }

                // create a reference to the generic worker instance
                this.#workers[family_code] = this.#modules['*generic*'];
            }

        }

        return this.#workers[family_code];
    }

    #get_paths(worker) {
        return Object.keys(worker?.paths)?.sort();
    }

    get paths() {
        let p = [];
        this.#devices = this.search();
        for (let d = 0, dl = this.#devices.length; d < dl; d++) {
            let id = this.#devices[d];
            // trace("id: " + id + "\n");
            let family = id.substring(0, 2);
            let worker = this.#get_worker(family);

            let paths = this.#get_paths(worker) || [];
            for (let i = 0, l = paths.length; i < l; i++) {
                p.push(`${id.substring(0,2)}.${id.substring(2)}/${paths[i]}`);
            }
        }
        return p.sort();
    }

    readPath(path) {

        if (typeof (path) !== "string") {
            throw new RangeError(`'${path}' is an invalid path.`)
        }

        path = path.toLowerCase();

        let pp = path.split("/");
        let id = pp.shift();

        if (!id || id.length < 16) {
            throw new RangeError(`'${path}' is an invalid path.`)
        }

        let family = id.substring(0, 2);

        // accept 28.FFFFFFF...
        // as well as 28FFFFFF...
        if (id[2] === ".") {
            id = family + id.substring(3);            
        }

        trace(id + "\n");

        let worker = this.#get_worker(family);

        let read_fn = worker?.paths?.[pp.join("/")]?.[0];
        return read_fn?.call(worker, this, id);

    }

    writePath(path, data) {

        if (typeof (path) !== "string") {
            throw new RangeError(`'${path}' is an invalid path.`)
        }

        path = path.toLowerCase();

        let pp = path.split("/");
        let id = pp.shift();

        if (!id || id.length < 8) {
            throw new RangeError(`'${path}' is an invalid path.`)
        }

        let family = id.substring(0, 2);

        // accept 28.FFFFFFF...
        // as well as 28FFFFFF...
        if (id[2] === ".") {
            id = family + id.substring(3);            
        }

        let worker = this.#get_worker(family);

        let write_fn = worker?.paths?.[pp.join("/")]?.[1];
        return write_fn?.call(worker, this, id, data);
    }

    checkCRC(buffer, length) {
        return utils.checkCRC(buffer, length);
    }
}

// Object.assign(DS2482, {
//     ROM_SIZE,
//     checkCRC: utils.checkCRC,
// });

// module.exports = DS2482;
export { DS2482 };
