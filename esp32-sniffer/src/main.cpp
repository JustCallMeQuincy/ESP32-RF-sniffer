#include <Arduino.h>
#include <Adafruit_SH1106.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <RCSwitch.h>
#include <SocketIOclient.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>

// config
#include "config.h"

WiFiClient WiFiclient;
SocketIOclient socketIO;

#define i2C_ADDRESS 0x3C
Adafruit_SH1106 display;
bool displayAvailable = false;

// buffer for the oled message
char messageBuffer[256];

#define pinLed 2

#define DEFAULT_TX_BITLENGTH 24

RCSwitch mySwitch = RCSwitch();

int code = 0;
bool ledStatus = false;

const size_t codeHistorySize = 4;
unsigned long codeHistory[codeHistorySize] = {0, 0, 0, 0};
size_t codeHistoryCount = 0;

void addReceivedCodeToHistory(unsigned long receivedCode)
{
    for (size_t i = codeHistorySize - 1; i > 0; --i)
    {
        codeHistory[i] = codeHistory[i - 1];
    }
    codeHistory[0] = receivedCode;

    if (codeHistoryCount < codeHistorySize)
    {
        codeHistoryCount++;
    }
}

void displayLastCodes()
{
    if (!displayAvailable)
    {
        return;
    }

    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("Last 4 codes:");

    for (size_t i = 0; i < codeHistoryCount; i++)
    {
        display.setCursor(0, 10 + (i * 10));
        display.printf("%lu", codeHistory[i]);
    }

    display.display();
}

void emitRfLog(unsigned long receivedCode, unsigned int bitLength, unsigned int pulseDelay, unsigned int protocol)
{
    DynamicJsonDocument rfPayload(256);
    rfPayload[0] = "rf_log";

    JsonObject payload = rfPayload[1].to<JsonObject>();
    payload["code"] = receivedCode;
    payload["bitlength"] = bitLength;
    payload["delay"] = pulseDelay;
    payload["protocol"] = protocol;
    payload["timestamp"] = millis();

    // Serialize into a stack buffer to avoid heap allocations
    char buf[512];
    size_t written = serializeJson(rfPayload, buf, sizeof(buf));
    if (written > 0)
    {
        socketIO.sendEVENT(buf);
    }
}

void emitTxAck(unsigned long sentCode, unsigned int bitLength)
{
    DynamicJsonDocument txPayload(128);
    txPayload[0] = "tx_ack";

    JsonObject payload = txPayload[1].to<JsonObject>();
    payload["code"] = sentCode;
    payload["bitlength"] = bitLength;
    payload["timestamp"] = millis();

    char buf[256];
    size_t written = serializeJson(txPayload, buf, sizeof(buf));
    if (written > 0)
    {
        socketIO.sendEVENT(buf);
    }
}

void emitHeartbeatAck()
{
    DynamicJsonDocument heartbeatPayload(128);
    heartbeatPayload[0] = "esp_heartbeat_ack";

    JsonObject payload = heartbeatPayload[1].to<JsonObject>();
    payload["timestamp"] = millis();

    char buf[256];
    size_t written = serializeJson(heartbeatPayload, buf, sizeof(buf));
    if (written > 0)
    {
        socketIO.sendEVENT(buf);
    }
}

/**
 * @brief helper function to display a message on the OLED
 *
 * @param messageBuffer
 */
void displayMessage(const char *messageBuffer)
{
    if (!displayAvailable)
    {
        return;
    }

    display.clearDisplay();
    display.setCursor(0, 1);
    display.println(messageBuffer);
    display.display();
}

/**
 * @brief event handler for the socketIO client
 *
 * @param type
 * @param payload
 * @param length
 */
void socketIOEvent(socketIOmessageType_t type, uint8_t *payload, size_t length)
{
    switch (type)
    {
    case sIOtype_DISCONNECT:
        Serial.printf("[SocketIo] Disconnected!\n");
        break;

    case sIOtype_CONNECT:
    {
        // payload may not be NUL-terminated; print safely
        char tmp[129];
        size_t copyLen = (length < (sizeof(tmp) - 1)) ? length : (sizeof(tmp) - 1);
        if (copyLen > 0 && payload != NULL)
        {
            memcpy(tmp, payload, copyLen);
        }
        tmp[copyLen] = '\0';
        Serial.printf("[SocketIo] Connected to url: %s\n", tmp);

        socketIO.send(sIOtype_CONNECT, "/");
    }
    break;

    case sIOtype_EVENT:
    {
        // print payload safely
        char tmp[257];
        size_t copyLen = (length < (sizeof(tmp) - 1)) ? length : (sizeof(tmp) - 1);
        if (copyLen > 0 && payload != NULL)
        {
            memcpy(tmp, payload, copyLen);
        }
        tmp[copyLen] = '\0';
        Serial.printf("[SocketIo] get event: %s\n", tmp);

        // parse the payload into a json object
        DynamicJsonDocument payloadObject(1024);
        DeserializationError error = deserializeJson(payloadObject, payload, length);

        if (error)
        {
            Serial.print(F("deserializeJson() failed: "));
            Serial.println(error.c_str());
            return;
        }

        const char *eventName = payloadObject[0];
        Serial.printf("[IOc] event name: %s\n", eventName);

        if (strcmp(eventName, "update") == 0)
        {
            JsonObject attributesObject = payloadObject[1].as<JsonObject>();

            if (attributesObject.containsKey("buttonState"))
            {
                bool buttonState = attributesObject["buttonState"];
                Serial.printf("[IOc] button state: %s\n", buttonState ? "true" : "false");
            }

            if (attributesObject.containsKey("message"))
            {
                const char *message = attributesObject["message"];
                Serial.printf("[IOc] message: %s\n", message);
                if (message != NULL && strcmp(message, "null") != 0)
                {
                    displayMessage(message);
                }
            }
        }

        if (strcmp(eventName, "clear") == 0)
        {
            Serial.printf("[IOc] clearing OLED screen\n");
            if (displayAvailable)
            {
                display.clearDisplay();
                display.display();
            }
        }

        if (strcmp(eventName, "esp_heartbeat") == 0)
        {
            Serial.printf("[IOc] heartbeat received\n");
            emitHeartbeatAck();
        }

        if (strcmp(eventName, "tx") == 0)
        {
            JsonObject attributesObject = payloadObject[1].as<JsonObject>();

            if (attributesObject.containsKey("code"))
            {
                // parse code (could be number or string)
                unsigned long txCode = 0;
                JsonVariant codeVar = attributesObject["code"];

                if (codeVar.is<const char *>())
                {
                    txCode = strtoul(codeVar.as<const char *>(), NULL, 10);
                }
                else
                {
                    txCode = codeVar.as<unsigned long>();
                }

                unsigned int bitLength = DEFAULT_TX_BITLENGTH;

                if (attributesObject.containsKey("meta") && attributesObject["meta"].is<JsonObject>())
                {
                    JsonObject meta = attributesObject["meta"].as<JsonObject>();
                    if (meta.containsKey("bitlength"))
                    {
                        bitLength = meta["bitlength"].as<unsigned int>();
                    }
                }
                else if (attributesObject.containsKey("bitlength"))
                {
                    bitLength = attributesObject["bitlength"].as<unsigned int>();
                }

                if (txPin >= 0 && bitLength > 0 && bitLength <= 64)
                {
                    mySwitch.send(txCode, bitLength);
                    // show on OLED briefly
                    snprintf(messageBuffer, sizeof(messageBuffer), "Sent: %lu", txCode);
                    displayMessage(messageBuffer);
                    emitTxAck(txCode, bitLength);
                }
                else
                {
                    Serial.println("Invalid TX parameters or transmitter disabled");
                }
            }
        }
        break;
    }
    }
}

void setup()
{
    delay(100);
    Serial.begin(115200);
    Serial.println("rf sniffer starting...");

    SPI.begin();
    Wire.begin();

    Wire.beginTransmission(i2C_ADDRESS);
    displayAvailable = (Wire.endTransmission() == 0);

    if (displayAvailable)
    {
        display.begin(SH1106_SWITCHCAPVCC, i2C_ADDRESS);
        display.clearDisplay();
        display.setTextSize(1);
        display.setTextColor(WHITE);

        displayMessage("oled init");
    }
    else
    {
        Serial.println("OLED not detected, continuing without display");
    }

    pinMode(pinLed, OUTPUT);

    if (rxPin >= 0)
    {
        mySwitch.enableReceive(rxPin);
        Serial.printf("Receiver enabled on pin %d\n", rxPin);
    }
    else
    {
        Serial.println("Receiver disabled (rxPin < 0)");
    }

    // enable transmitter if configured
    if (txPin >= 0)
    {
        mySwitch.enableTransmit(txPin);
        Serial.printf("Transmitter enabled on pin %d\n", txPin);
    }
    else
    {
        Serial.println("Transmitter disabled (txPin < 0)");
    }

    WiFi.begin(ssid, password);

    // Wait for connection with timeout (60 * 500ms = 30s)
    int attempts = 0;
    const int maxAttempts = 60;
    while (WiFi.status() != WL_CONNECTED && attempts < maxAttempts)
    {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED)
    {
        IPAddress ip = WiFi.localIP();
        char ipbuf[32];
        snprintf(ipbuf, sizeof(ipbuf), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
        Serial.printf("WiFi Connected %s\n", ipbuf);

        snprintf(messageBuffer, sizeof(messageBuffer), "WiFi connected\n\nIp: %s\n", ipbuf);
        displayMessage(messageBuffer);
    }
    else
    {
        Serial.println("WiFi connection timed out");
        snprintf(messageBuffer, sizeof(messageBuffer), "WiFi not connected\n");
        displayMessage(messageBuffer);
    }

    // server address, port and URL
    socketIO.begin(host, port, "/socket.io/?EIO=4");

    // event handler
    socketIO.onEvent(socketIOEvent);
}

void loop()
{
    socketIO.loop();
    digitalWrite(pinLed, ledStatus);

    if (mySwitch.available())
    {
        unsigned long receivedCode = mySwitch.getReceivedValue();
        unsigned int bitLength = mySwitch.getReceivedBitlength();
        unsigned int pulseDelay = mySwitch.getReceivedDelay();
        unsigned int protocol = mySwitch.getReceivedProtocol();

        addReceivedCodeToHistory(receivedCode);
        displayLastCodes();
        emitRfLog(receivedCode, bitLength, pulseDelay, protocol);

        if (receivedCode != 0)
        {
            ledStatus = !ledStatus; // Toggle LED status on each received code
        }

        mySwitch.resetAvailable();
    }
}