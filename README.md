# Pre-requisites
## Physical
- An ESP32 with
    - RF 433Mhz RX module connected to `GPIO 13`
    - RF 433Mhz TX module connected to `GPIO 04`
- USB Type-C cable to connect the ESP32 to your computer
- A computer to run the back-end and web application
- A network with LAN access

## Software
- Visual Studio Code with the following extensions:
  - NodeJS
  - PlatformIO
- Web browser

# Setup
Clone the project to your local device and open Visual Studio Code in the directory.

**Example:**
clone the project
```git clone https://github.com/JustCallMeQuincy/ESP32-RF-sniffer.git```
then use
```cd ./ESP32-RF-sniffer```
to enter its directory

## Setup the back-end
1. Choose a port (default value in `socketio-backend/server.js` for `var port` is `8890`)
2. Install NodeJS
3. In the terminal, navigate to the `socketio-backend` folder (`cd ./socketio-backend`)
4. Run `npm install`, then run `npm run start`
5. Get the ip address of your device using `ipconfig` in your Command Prompt or terminal, you will need it later

>[!note]
>Usually, one would use the value from `IPv4 Address. . . . . . . . . . . :` under your `Wireless LAN adapter Wi-Fi`.

## Debug logging
The backend can optionally print full payloads (TX and RX) to the console for debugging. By default only heartbeats and ping/pong messages are logged.

Enable payload logging by setting an environment variable before starting the server:

PowerShell:
```powershell
$env:DEBUG_PAYLOADS = "1"
node socketio-backend/server.js
```

Command Prompt (cmd):
```cmd
set DEBUG_PAYLOADS=1&& node socketio-backend/server.js
```

Unix / macOS (bash/zsh):
```bash
DEBUG_PAYLOADS=1 node socketio-backend/server.js
```

You can also set `DEBUG=true` as an alternative flag. When `DEBUG_PAYLOADS` is not set, the server will continue to emit heartbeat and ping logs but will suppress TX/RX payload console output.

All RX and TX transmissions are logged in the `backend.log` file.

## Setup the ESP32
1. Connect the wiring on the ESP32, following the wiring diagram below
2. Configure `esp32-sniffer/src/config.h.txt` and rename the file to `config.h` (removing the `.txt` extension)
3. Navigate to the `esp32-sniffer` folder (`cd ./esp32-sniffer`)
4. Connect the ESP32 to your device
5. Use PlatformIO to flash the firmware to the ESP32

### Diagrams using the ESP32-NodeMCU-32S
#### Wiring diagram
![Wiring diagram](media/Wiring%20diagram.png)

#### Board pinout
![ESP32-NodeMCU-32S pinout](media/ESP32-NodeMCU-32S%20pinout.png)

## Viewing the webpage
Navigate to http://localhost:8890/

If you'd like to access the webpage from a different device;
1. Connect the device to the same network as the web application
2. Navigate to `http://IP-of-device:8890/` -- this is the same IP address you obtained when starting up the back-end

# Limitations
- Connecting multiple ESPs is not currently supported
- There's no security setup (https, wss)
- The repetition functionalities do not take the ESP hardware into account - extended use may overheat or crash the device

# Purpose
This is a testing/demo tool, not meant for any purposes outside of educational context.

# Possible additions
## Display (OLED)
This project optionally supports a small I2C OLED (SH1106) used to show short messages and the last received RF codes.

- Driver: `Adafruit_SH1106` (used in `esp32-sniffer/src/main.cpp`).
- I2C address: `0x3C` (defined as `i2C_ADDRESS` in the source).

### Wiring
(ESP32 common defaults)
- `VCC` -> `3.3V`
- `GND` -> `GND`
- `SDA` -> `GPIO 21` (ESP32 SDA)
- `SCL` -> `GPIO 22` (ESP32 SCL)

### Notes about the implementation
- The firmware probes the I2C address at startup; if a device responds, the display is initialized and `displayAvailable` is set to true. Initialization occurs in `setup()`; see [esp32-sniffer/src/main.cpp (lines 280-296)](esp32-sniffer/src/main.cpp#L280-L296).
- Use the helper `displayMessage(const char *messageBuffer)` to show short messages. Implementation: [esp32-sniffer/src/main.cpp (lines 117-136)](esp32-sniffer/src/main.cpp#L117-L136).
- The helper `displayLastCodes()` draws the header and the last received codes kept in `codeHistory[]`. Implementation: [esp32-sniffer/src/main.cpp (lines 51-70)](esp32-sniffer/src/main.cpp#L51-L70). Codes are added by `addReceivedCodeToHistory()` near the top of the file.
- On RF reception, the firmware updates the history and refreshes the OLED via `displayLastCodes()`; see the receive handling in `loop()`: [esp32-sniffer/src/main.cpp (lines 330-370)](esp32-sniffer/src/main.cpp#L330-L370).
- The Socket.IO event handler can trigger display updates: it calls `displayMessage()` for remote `update` messages containing a `message`, clears the screen on `clear`, and briefly shows transmitted codes when handling `tx` requests. See socket handler: [esp32-sniffer/src/main.cpp (lines 140-240)](esp32-sniffer/src/main.cpp#L140-L240).

If your display uses a different controller (e.g., SSD1306) you can either change the driver include or wire a compatible SH1106 module. The code will continue to run without an OLED if none is detected.
