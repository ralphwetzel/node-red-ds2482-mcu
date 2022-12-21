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
import { CRC8, CRC16 } from "crc";
import Hex from "hex";

const ROM_SIZE = 8;

class owGeneric {
    paths = { "not_implemented": [] }
}

function i2c_write_async(i2c, bytesArray) {
    return new Promise((resolve, reject) => {
        i2c.write(Uint8Array.from(bytesArray).buffer, true, (err) => {
            if (err) {
                reject(Error(`I2C Write failed: ${err.toString()}`));
                return;
            }
            resolve();
        })
    })
}

function i2c_write_sync(i2c, bytesArray) {
    return new Promise((resolve, reject) => {
        try {
            i2c.write(Uint8Array.from(bytesArray).buffer, true);
        } catch (err) {
            reject(Error(`I2C Write failed: ${err.toString()}`));
            return;
        }
        resolve();
    });
}

function i2c_read_async(i2c) {
    return new Promise((resolve, reject) => {
        let buffer = new Uint8Array(1);
        i2c.read(buffer, (err, count) => {
            if (err) {
                reject(Error(`I2C Read failed: ${err.toString()}`));
                return;
            }
            resolve(count > 0 ? (buffer[0] & 0xFF) : undefined);
        });
    });
}

function i2c_read_sync(i2c) {
    return new Promise((resolve, reject) => {
        try {
            let buffer = new Uint8Array(1);
            let count = i2c.read(buffer, true);
            resolve(count > 0 ? (buffer[0] & 0xFF) : undefined);
            return;
        } catch (err) {
            reject(Error(`I2C Read failed: ${err.toString()}`));
        }
    });
}

class DS2482 {

    #modules4devices = config_from_manifest?.ds2482?.devices;
    #modules = {};

    #devices = [];
    #workers = {};

    // https://javascript.info/currying-partials
    #curry = function (f) {
        return function(a) {
            return function(b) {
            return f(a, b);
            };
        };
    }

    constructor(i2c, async) {
        this.i2c = i2c;
        this.channel = null;

        // https://javascript.info/currying-partials
        let curry = function (f) {
            return function(a) {
                return function(b) {
                return f(a, b);
                };
            };
        }

        if (async) {

            let cra = curry(i2c_read_async);
            this._i2cRead = cra(this.i2c);

            let cwa = curry(i2c_write_async);
            this._i2cWrite = cwa(this.i2c);

        } else {

            let crs = curry(i2c_read_sync);
            this._i2cRead = crs(this.i2c);

            let cws = curry(i2c_write_sync);
            this._i2cWrite = cws(this.i2c);

        }
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

        return this._resetBridge()
            .then(() => this._resetWire());
    }

    configureBridge(options) {
        let config = 0;

        // trace("@configureBridge\n");

        if (options) {
            if (options.activePullup) config |= cmds.CONFIG.ACTIVE;
            if (options.strongPullup) config |= cmds.CONFIG.STRONG;
            if (options.overdrive) config |= cmds.CONFIG.OVERDRIVE;
        }

        return this._wait(true)
            .then(() => this._i2cWrite([cmds.WRITE_CONFIG, ((~config & 0x0F) << 4) | config]))
            .then(() => this._readBridge())
            .then(resp => {
                if (config !== resp) {
                    throw Error('Failed to configure bridge');
                }
                // trace("@configureBridge Done\n");

                return resp;
            });
    }

    selectChannel(num) {
        const ch = cmds.SELECTION_CODES[num || 0];

        if (!ch) {
            return Promise.reject(Error('Invalid channel'));
        }

        if (this.channel === num) {
            return Promise.resolve(ch.read);
        }

        return this._wait(true)
            .then(() => this.writeData([cmds.CHANNEL_SELECT, ch.write]))
            .then(() => this._readBridge())
            .then(resp => {
                if (ch.read !== resp) {
                    throw Error('Failed to select channel');
                }

                this.channel = num;

                return resp;
            });
    }

    sendCommand(cmd, rom) {
        return (rom ? this.matchROM(rom) : this.skipROM())
            .then(() => this.writeData([cmd]));
    }

    search() {
        this.lastFound = null;
        this.lastConflict = 0;

        const found = [];

        const searchNext = () => (
            this.searchROM()
            .then(resp => {
                trace("found: " + resp + "\n");

                found.push(resp);
                // trace(`LastConflict: ${this.lastConflict}\n`);

                if (this.lastConflict) {
                    return searchNext();
                }

                this.lastFound = null;
                this.lastConflict = 0;

                return found;
            })
            .catch((err) => {
                // throw err;
            })
        );

        return searchNext();
    }

    searchByFamily(family) {
        if (typeof family === 'string') {
            // eslint-disable-next-line no-param-reassign
            family = parseInt(family, 16);
        }

        this.lastFound = Uint8Array.of(family, 0, 0, 0, 0, 0, 0, 0);
        this.lastConflict = 64;

        const found = [];

        const searchNext = () => (
            this.searchROM().then(resp => {
                if (this.lastFound[0] === family) {
                    found.push(resp);
                }

                if (this.lastConflict > 7 && found.length) {
                    return searchNext();
                }

                this.lastFound = null;
                this.lastConflict = 0;

                return found;
            })
        );

        return searchNext();
    }

    /*
     * Onewire ROM API
     */

    searchROM() {
        const rom = new Uint8Array(ROM_SIZE);

        let offset = 0;
        let mask = 0x01;
        let bit = 1;
        let lastConflict = 0;

        const direction = () => {
            if (this.lastFound && bit < this.lastConflict) {
                return this.lastFound[offset] & mask;
            }

            return bit === this.lastConflict ? 1 : 0;
        };

        const searchNextBit = () => {

                let dirction = direction();

                return this.triplet(dirction)
                .then(resp => {
                    const sbr = (resp & cmds.STATUS.SINGLE_BIT);
                    const tsb = (resp & cmds.STATUS.TRIPLE_BIT);
                    const dir = (resp & cmds.STATUS.BRANCH_DIR);
    
                    if (sbr && tsb) {
                        throw Error('Bad search result');
                    }
    
                    if (!sbr && !tsb && !dir) {
                        // trace("@last conflict: " + bit + "\n");
                        lastConflict = bit;
                    }
    
                    const part = rom[offset];
    
                    rom[offset] = dir ? part | mask : part & ~mask;

                    // trace(`direction: ${dirction} | dir: ${dir} | bit: ${bit} | mask: ${mask} | offset: ${offset} | status: ${Hex.toString(rom)}\n`);

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
                        throw Error('ROM invalid');
                    }
    
                    if (this.crc8(rom) !== 0) {
                        throw Error('CRC mismatch');
                    }
    
                    this.lastFound = rom;
                    this.lastConflict = lastConflict;
    
                    return Hex.toString(rom);
                })
                // .catch((err) => {
                //     // throw err;
                // })
    
            }
    
        return this._resetWire()
            .then(() => this.writeData([cmds.ONE_WIRE_SEARCH_ROM]))
            .then(() => searchNextBit());
    }

    readROM() {
        return this._resetWire()
            .then(() => this.writeData([cmds.ONE_WIRE_READ_ROM]))
            .then(() => this.readData(ROM_SIZE))
            .then(rom => {
                if (rom[0] === 0) {
                    throw Error('ROM invalid');
                }

                if (this.crc8(rom) !== 0) {
                    throw Error('CRC mismatch');
                }

                return Hex.toString(rom);
            });
    }

    matchROM(rom) {

        if (typeof rom !== 'string') {
            return Promise.reject(TypeError(`${rom}: Type not string.`));
        }
    
        if (rom.length !== ROM_SIZE * 2) {
            return Promise.reject(Error(`${rom}: ROM invalid.`));
        }
    
        if (rom[0] === "0" && rom[1] === "0") {
            return Promise.reject(Error(`${rom}: ROM invalid.`));
        }

        // writeData expects a dataArray (or a TypedArray)
        rom = new Uint8Array(Hex.toBuffer(rom));

        return this._resetWire()
            .then(() => this.writeData([cmds.ONE_WIRE_MATCH_ROM]))
            .then(() => this.writeData(rom));
    }

    skipROM() {
        return this._resetWire()
            .then(() => this.writeData([cmds.ONE_WIRE_SKIP_ROM]));
    }

    /*
     * Onewire read/write API
     */

    writeData(dataArray, length) {

        length = length ?? dataArray.length;
        let offset = 0;

        const writeNextByte = () => {

            // trace("writeData: " + dataArray[offset] + "\n")

            return this._i2cWrite([cmds.ONE_WIRE_WRITE_BYTE, dataArray[offset]])
                .then(() => this._wait())
                .then(resp => {
                    offset += 1;

                    if (offset < length) {
                        return writeNextByte();
                    }

                    return resp;
                })
            };

        return this._wait(true).then(() => writeNextByte());
    }

    readData(size) {
        const data = new Uint8Array(size);

        let offset = 0;
        const readByteCmd = [cmds.ONE_WIRE_READ_BYTE];

        const readNextByte = () => (
            this._i2cWrite(readByteCmd)
                .then(() => this._wait())
                .then(() => this._readBridge(cmds.REGISTERS.DATA))
                .then(resp => {
                    data[offset] = resp;
                    offset += 1;

                    if (offset < size) {
                        return readNextByte();
                    }

                    return data;
                })
        );

        return this._wait(true).then(() => readNextByte());
    }

    bit(setHigh) {
        return this._wait(true)
            .then(() => this._i2cWrite([cmds.ONE_WIRE_SINGLE_BIT, setHigh ? 0x80 : 0]))
            .then(() => this._wait())
            .then(resp => (resp & cmds.STATUS.SINGLE_BIT ? 1 : 0));
    }

    triplet(dir) {
        return this._wait(true)
            .then(() => this._i2cWrite([cmds.ONE_WIRE_TRIPLET, dir ? 0x80 : 0]))
            .then(() => this._wait());
    }

    /*
     * Private Methods
     */

    _resetBridge() {
        return this._i2cWrite([cmds.DEVICE_RESET])
            .then(() => this._wait())
            .then(resp => {
                this.channel = 0;

                return resp;
            });
    }

    _resetWire() {
        return this._wait(true)
            .then(() => this._i2cWrite([cmds.ONE_WIRE_RESET]))
            .then(() => this._wait())
            .then(resp => {
                if (resp & cmds.STATUS.SHORT) {
                    throw Error('Detected onewire short');
                }

                if (!(resp & cmds.STATUS.PRESENCE)) {
                    throw Error('Failed to detected any onewire devices');
                }

                return resp;
            });
    }

    _wait(setPointer) {

        let cancel_timeout = false;

        const checkBusy = reg => (
            this._readBridge(reg)
            .then(resp => {
                // trace("@_wait: " + resp + "\n");
                if (resp & cmds.STATUS.BUSY) {
                    return this.timeout(50).then(() => checkBusy());
                }

                cancel_timeout = true;
                return resp;
            })
            .catch ((err) => {
                cancel_timeout = true;
                throw err;
            })
        );

        return Promise.race([
            checkBusy(setPointer ? cmds.REGISTERS.STATUS : null),
            this.timeout(200).then(() => {
                if (!cancel_timeout)
                    throw Error('Wait timeout');
            }),
        ]);
    }

    _readBridge(reg) {
        const read = () => (
            this._i2cRead().then(resp => {
                // trace("@_readBridge Done: " + resp + "\n");
                return (resp >>> 0) & 0xFF;
            })
        );

        if (reg) {
            return this._i2cWrite([cmds.SET_READ_POINTER, reg]).then(read);
        }

        return read();
    }

    // 20221206 RDW
    // Redefined on top to support ECMA-419 I2C.Async

    // _i2cWrite(bytesArray) {
    //     ...
    // }

    // _i2cRead() {
    //     ...
    // }

    /*
        1-Wire device access API by path
     */

    // Simple & perhaps naive semaphore implementation
    #lock = false;

    #get_I2C_lock(timeout) {

        let cancel_timeout = false;

        trace("Trying to acquire I2C lock...\n");

        const checkLock = () => {
            if (this.#lock) {
                trace("I2C lock blocked!\n");
                return this.timeout(50).then(() => checkLock());
            }

            this.#lock = true;
            trace("I2C lock acquired\n");
            cancel_timeout = true;
            return Promise.resolve();
        }

        return Promise.race([
            checkLock(),
            this.timeout(timeout).then(() => {
                if (!cancel_timeout)
                    throw Error('Timeout: Could not acquire I2C lock.');
            }),
        ]);

    }

    #release_I2C_lock() {
        this.#lock = false;
        trace("I2C lock released\n");        
    }

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

    // get paths() {
    //     let p = [];
    //     this.#devices = this.search();
    //     trace(JSON.stringify(this.#devices) + "\n");
    //     for (let d = 0, dl = this.#devices.length; d < dl; d++) {
    //         let id = this.#devices[d];
    //         // trace("id: " + id + "\n");
    //         let family = id.substring(0, 2);
    //         let worker = this.#get_worker(family);

    //         let paths = this.#get_paths(worker) || [];
    //         for (let i = 0, l = paths.length; i < l; i++) {
    //             p.push(`${id.substring(0,2)}.${id.substring(2)}/${paths[i]}`);
    //         }
    //     }
    //     return p.sort();
    // }

    get paths() {
        return new Promise((resolve, reject) => {

            let p = [];

            this.#get_I2C_lock(5000)
            .then(() => this.search())
            .then((devs) => {

                this.#release_I2C_lock();

                trace(`Devices found: ${JSON.stringify(devs)}\n`);

                if (Array.isArray(devs)) {
                    this.#devices = devs;

                    for (let d = 0, dl = devs.length; d < dl; d++) {
                        let id = devs[d];
                        // trace("id: " + id + "\n");
                        let family = id.substring(0, 2);
                        let worker = this.#get_worker(family);
            
                        let paths = this.#get_paths(worker) || [];
                        for (let i = 0, l = paths.length; i < l; i++) {
                            p.push(`${id.substring(0,2)}.${id.substring(2)}/${paths[i]}`);
                        }
                    }        
                }

                return resolve(p.sort());
            })
            .catch((err) => {
                this.#release_I2C_lock();
                reject(err);
            })
        })
    }

    readPath(path) {

        return new Promise((resolve, reject) => {

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

            // trace(id + "\n");

            let worker = this.#get_worker(family);
            let read_fn = worker?.paths?.[pp.join("/")]?.[0];

            if (!read_fn) {
                // trace("ds.readPath -> resolve(undefined)\n");
                resolve(undefined);
                return;
            }

            this.#get_I2C_lock(1000)
            .then(() => read_fn.call(worker, this, id))
            .then((result) => {
                resolve(result);
            })
            .catch((err) => {
                reject(err);
            })
            .finally(() => {
                this.#release_I2C_lock();
            });
            return;

        });
    }

    writePath(path, data) {

        return new Promise((resolve, reject) => {

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

            if (!write_fn) {
                // trace("ds.writePath -> resolve(undefined)\n");
                resolve(undefined);
                return;
            }

            this.#get_I2C_lock(1000)
            .then(() => write_fn.call(worker, this, id, data))
            .then((result) => {
                resolve(result);
            })
            .catch((err) => {
                reject(err);
            })
            .finally(() => {
                this.#release_I2C_lock();
            });
            return;
        });
    }


        // Utility functions - that can be used by device drivers

        timeout(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        crc8(uint8arr) {

            // definition by @moddable
            // 	{ poly: 0x31, init: 0x00, res: 0xA1, refIn: true,  refOut: true,  xorOut: 0x00, name: "CRC-8/MAXIM" },
            let crc = new CRC8(0x31, 0x00, true, true, 0x00);
    
            // crc.reset();
            return crc.checksum(uint8arr);
        }
    
        crc16(uint8arr) {
    
            // definition by @moddable
            // { poly: 0x8005, init: 0x0000, res: 0x44C2, refIn: true,  refOut: true,  xorOut: 0xFFFF, name: "CRC-16/MAXIM" },
            let crc = new CRC16(0x8005, 0, true, true, 0xFFFF);
    
            // crc.reset();
            return crc.checksum(uint8arr);
        }
    
        readUInt16LE(uint8arr, offset) {
            offset = offset >>> 0
            return uint8arr[offset] | (uint8arr[offset + 1] << 8)
        }
    
        readInt16LE(uint8arr, offset) {
            offset = offset >>> 0
            const val = uint8arr[offset] | (uint8arr[offset + 1] << 8)
            return (val & 0x8000) ? val | 0xFFFF0000 : val
        }


    
}

export { DS2482 };