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

    #cmds = Object.freeze({
        WRITE_SCRATCHPAD: 0x4E,
        READ_SCRATCHPAD: 0xBE,
        COPY_SCRATCHPAD: 0x48,
        RECALL_SCRATCHPAD: 0xB8,
        CONVERT_TEMP: 0x44,
        POWER_SUPPLY: 0xB4
    })

    #resolution = Object.freeze({
            // config, delay, mask, scale
        "9":  [0x1F, 110, 0xF8, 16.],
        "10": [0x3F, 200, 0xFC, 16.],
        "11": [0x5F, 400, 0xFE, 16.],
        "12": [0x7F,1000, 0xFF, 16.]
    })

    // matchROM(id) {
    //     if (!id) { return; }
    //     bridge.matchROM(id);
    // }

    #temp_conv(bridge, id, precision, SPU) {

        precision = precision ?? 12;
        SPU = SPU ?? false;

        // confirm and set precision
        let sp = this.#read_sp(bridge, id);
        if (sp[4] != this.#resolution[precision][0]) {
            this.#write_sp(bridge, id, sp[2], sp[3], this.#resolution[precision][0]);
        }

        if (SPU === true) {

            bridge.matchROM(id);
            bridge.strongPullup();
            bridge.writeData([this.#cmds.CONVERT_TEMP]);
            Timer.delay(this.#resolution[precision][1]);

        } else {

            bridge.matchROM(id);
            bridge.writeData([this.#cmds.CONVERT_TEMP]);

            let stop = false;
            let conv_timer = Timer.set(() => {
                stop = true;
            }, this.#resolution[precision][1]);

            let rb;
            do {
                if (rb) {
                    Timer.delay(30);
                }
                rb = bridge.readData(1);

                trace(`${rb[0]} / ${stop}\n`);

            } while ((rb[0] == 0) && (stop == false))

            Timer.clear(conv_timer);
        }

        return this.#temp_fetch(bridge, id, precision);
    }


    #read_sp(bridge, id, length) {
        
        length = length ?? 9;

        let self = this;
        let count = 0;
        let crc;
        let sp;

        function r(b, i, l) {
            b.matchROM(i)
            b.writeData([self.#cmds.READ_SCRATCHPAD]);
            return b.readData(l);
        }

        // no crc check!
        if (length < 9) { 
            sp = r(bridge, id, length);
            bridge._resetWire();
            return sp;
        }

        do {
            sp = r(bridge, id, length);
            count++;
            crc = bridge.checkCRC(sp)
        } while (true == false) // ((crc === false) && count < 5)

        return sp;
    }

    #write_sp(bridge, id, Th, Tl, CB) {

        Th = Th ?? 0;
        Tl = Tl ?? 0;
        CB = CB ?? 0;

        bridge.matchROM(id);
        bridge.writeData([this.#cmds.WRITE_SCRATCHPAD]);

        // All 3 bytes MUST be written always!
        bridge.writeData([Th, Tl, CB]);

    }

    #temp_fetch(bridge, id, precision) {
        precision = precision ?? 12;

        let sp = this.#read_sp(bridge, id, 2);
        sp[0] = sp[0] & this.#resolution[precision][2];
        let t = sp.readInt16LE(0);
        return t / this.#resolution[precision][3];
    }


    temperature9(bridge, id) {
        return this.#temp_conv(bridge, id, 9); 
    }

    temperature10(bridge, id) {
        return this.#temp_conv(bridge, id, 10); 
    }

    temperature11(bridge, id) {
        return this.#temp_conv(bridge, id,  11); 
    }

    temperature12(bridge, id) {
        return this.#temp_conv(bridge, id, 12); 
    }

    p_temperature9(bridge, id) {
        return this.#temp_conv(bridge, id, 9, true); 
    }

    p_temperature10(bridge, id) {
        return this.#temp_conv(bridge, id, 10, true);
    }

    p_temperature11(bridge, id) {
        return this.#temp_conv(bridge, id, 11, true);
    }

    p_temperature12(bridge, id) {
        return this.#temp_conv(bridge, id, 12, true);
    }

}

export { ds18b20 as default}