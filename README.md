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
## Setup the back-end
1. Choose a port (default value in `socketio-backend/server.js` for `var port` is `8890`)
2. Install NodeJS
3. In the terminal, navigate to the `socketio-backend` folder (`cd ./socketio-backend`)
4. Run `npm install`, then run `npm run start`
5. Get the ip address of your device using `ipconfig` in your Command Prompt or terminal, you will need it later

>[!note]
>Usually, one would use the vlaue from `IPv4 Address. . . . . . . . . . . :` under your `Wireless LAN adapter Wi-Fi`.

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
- Currently, when refreshing the page - the last 20 logs are displayed. This is done to prevent bad performance or long loading times

# Purpose
This is a testing/demo tool, not meant for any purposes outside of educational context.
