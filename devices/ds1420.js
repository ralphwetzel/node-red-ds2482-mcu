/*
    node-red-DS2482-mcu by @ralphwetzel
    https://github.com/ralphwetzel/node-red-DS2482-mcu
    License: MIT
*/

// This class support family codes 0x01 & 0x81

class ds1420 {

    paths = {
        "id": [this.id]
    }

    id(bridge, id) {
        return id(this, bridge, id);
    }

}

async function id(self, bridge, id) {
    return id;
}

export { ds1420 as default}