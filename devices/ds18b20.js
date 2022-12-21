/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-DS2482-mcu
    License: MIT
*/

import Timer from "timer";

class ds18b20 {

    paths = {
        "temperature": [this.temperature10],
        "temperature9": [this.temperature9],
        "temperature10": [this.temperature10],
        "temperature11": [this.temperature11],
        "temperature12": [this.temperature12],
        "parasite/temperature": [this.p_temperature10],
        "parasite/temperature9": [this.p_temperature9],
        "parasite/temperature10": [this.p_temperature10],
        "parasite/temperature11": [this.p_temperature11],
        "parasite/temperature12": [this.p_temperature12]
    }

    cmds = Object.freeze({
        WRITE_SCRATCHPAD: 0x4E,
        READ_SCRATCHPAD: 0xBE,
        COPY_SCRATCHPAD: 0x48,
        RECALL_SCRATCHPAD: 0xB8,
        CONVERT_TEMP: 0x44,
        POWER_SUPPLY: 0xB4
    })

    resolution = Object.freeze({
            // config, delay, mask, scale
        "9":  [0x1F, 110, 0xF8, 16.],
        "10": [0x3F, 200, 0xFC, 16.],
        "11": [0x5F, 400, 0xFE, 16.],
        "12": [0x7F,1000, 0xFF, 16.]
    })

    temperature9(bridge, id) {
        return temp_conv(this, bridge, id, 9); 
    }

    temperature10(bridge, id) {
        return temp_conv(this, bridge, id, 10); 
    }

    temperature11(bridge, id) {
        return temp_conv(this, bridge, id,  11); 
    }

    temperature12(bridge, id) {
        return temp_conv(this, bridge, id, 12); 
    }

    p_temperature9(bridge, id) {
        return temp_conv(this, bridge, id, 9, true); 
    }

    p_temperature10(bridge, id) {
        return temp_conv(this, bridge, id, 10, true);
    }

    p_temperature11(bridge, id) {
        return temp_conv(this, bridge, id, 11, true);
    }

    p_temperature12(bridge, id) {
        return temp_conv(this, bridge, id, 12, true);
    }

}


async function temp_conv(self, bridge, id, precision, SPU) {

    precision = precision ?? 12;
    SPU = SPU ?? false;

    // confirm and set precision
    let sp = await read_sp(self, bridge, id);
    if (sp[4] != self.resolution[precision][0]) {
        await write_sp(self, bridge, id, sp[2], sp[3], self.resolution[precision][0]);
    }

    if (SPU === true) {

        await bridge.matchROM(id);
        await bridge.strongPullup();
        await bridge.writeData([self.cmds.CONVERT_TEMP]);
        await bridge.timeout(self.resolution[precision][1]);

    } else {

        await bridge.matchROM(id);
        await bridge.writeData([self.cmds.CONVERT_TEMP]);

        let stop = false;
        let conv_timer = Timer.set(() => {
            stop = true;
        }, self.resolution[precision][1]);

        let rb;
        do {
            if (rb) {
                await bridge.timeout(30);
            }
            rb = await bridge.readData(1);

        } while ((rb[0] == 0) && (stop == false))

        Timer.clear(conv_timer);
    }

    return temp_fetch(self, bridge, id, precision);
}

async function read_sp(self, bridge, id, length) {
        
    length = length ?? 9;

    async function r(b, i, l) {
        await b.matchROM(i);
        await b.writeData([self.cmds.READ_SCRATCHPAD]);
        return await b.readData(l);
    }

    // no crc check!
    if (length < 9) { 
        let sp = await r(bridge, id, length);
        await bridge._resetWire();
        return sp;
    }

    let count = 0;
    let crc;
    let sp;

    do {

        sp = await r(bridge, id, length);
        count++;

        if (sp instanceof Uint8Array) {
            crc = bridge.crc8(sp)
        } else {
            crc = -1;
        }

    } while ((crc !== 0) && count < 5)

    return sp;
}

async function write_sp(self, bridge, id, Th, Tl, CB) {

    Th = Th ?? 0;
    Tl = Tl ?? 0;
    CB = CB ?? 0;

    await bridge.matchROM(id);
    await bridge.writeData([self.cmds.WRITE_SCRATCHPAD]);

    // All 3 bytes MUST be written always!
    await bridge.writeData([Th, Tl, CB]);

}

async function temp_fetch(self, bridge, id, precision) {
    precision = precision ?? 12;

    let sp = await read_sp(self, bridge, id, 2);
    sp[0] = sp[0] & self.resolution[precision][2];
    let t = bridge.readInt16LE(sp, 0);
    return t / self.resolution[precision][3];
}



export { ds18b20 as default}