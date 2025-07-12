import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

const manager = new BleManager();

const SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
const RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

let packetBuffer = Buffer.alloc(0);

const parseRaceBoxLiveData = (buffer) => {
  if (buffer.length < 90) return null;
  if (buffer[0] !== 0xB5 || buffer[1] !== 0x62) return null;

  const msgClass = buffer[2];
  const msgId = buffer[3];
  const payloadLength = buffer.readUInt16LE(4);

  if (msgClass !== 0xFF || msgId !== 0x01 || payloadLength !== 80) return null;

  const payloadStart = 6;
  const payload = buffer.slice(payloadStart, payloadStart + payloadLength);

  const data = {};
  data.utc_time = payload.readUInt32LE(0);
  data.latitude = payload.readInt32LE(24) / 1e7;
  data.longitude = payload.readInt32LE(28) / 1e7;
  data.altitude_wgs = payload.readInt32LE(32) / 1000;
  data.altitude_msl = payload.readInt32LE(36) / 1000;

  const speed_mm_s = payload.readInt32LE(48);
  data.speed_mph = (speed_mm_s / 1000) * 2.23694;

  data.heading = payload.readInt32LE(52) / 1e5;

  // 🔔 Print raw integer values for diagnostics
  const rawGforceX = payload.readInt32LE(56);
  const rawGforceY = payload.readInt32LE(60);
  const rawGforceZ = payload.readInt32LE(64);
  console.log(`🧐 Raw G-forces: X=${rawGforceX} Y=${rawGforceY} Z=${rawGforceZ}`);

  data.g_force_x = rawGforceX / 1e6;
  data.g_force_y = rawGforceY / 1e6;
  data.g_force_z = rawGforceZ / 1e6;

  data.gyro_x = payload.readInt32LE(68) / 1e5;
  data.gyro_y = payload.readInt32LE(72) / 1e5;
  data.gyro_z = payload.readInt32LE(76) / 1e5;

  return data;
};


export default function App() {
  const [latestMessage, setLatestMessage] = useState('');
  const [status, setStatus] = useState('Waiting for Bluetooth...');

  useEffect(() => {
    const subscription = manager.onStateChange((state) => {
      if (state === 'PoweredOn') {
        setStatus('Bluetooth ready. Scanning...');
        scanAndConnect();
        subscription.remove();
      }
    }, true);

    return () => {
      manager.destroy();
    };
  }, []);

  const scanAndConnect = async () => {
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      const hasAllPermissions =
        granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED;

      if (!hasAllPermissions) {
        setStatus('Bluetooth permissions not granted');
        return;
      }
    }

    console.log('🔍 Starting BLE scan...');
    manager.startDeviceScan(null, null, async (error, device) => {
      if (error) {
        console.log('Scan error:', error);
        setStatus('Scan error');
        return;
      }

      console.log('📡 Found device:', device?.name, device?.id);

      if (device?.name?.includes('RaceBox')) {
        console.log('🎯 Found RaceBox device:', device.name, device.id);
        setStatus('RaceBox found, 📡 Connecting to GPS ...');
        manager.stopDeviceScan();

        try {
          const connectedDevice = await device.connect();
          console.log('✅ Connected to RaceBox:', connectedDevice.id);

          await connectedDevice.discoverAllServicesAndCharacteristics();
          console.log('🔍 Services discovered');

          await connectedDevice.requestMTU(512);
          setStatus('📊 Output Data Stream:');

          connectedDevice.monitorCharacteristicForService(
            SERVICE_UUID,
            TX_CHAR_UUID,
            (error, characteristic) => {
              if (error) {
                console.error('Monitor error:', error);
                setStatus('❌ Connection Error');
                return;
              }

              if (characteristic?.value) {
                const incoming = Buffer.from(characteristic.value, 'base64');
                packetBuffer = Buffer.concat([packetBuffer, incoming]);

                while (packetBuffer.length >= 2) {
                  const syncPos = packetBuffer.indexOf(0xB5);

                  if (
                    syncPos === -1 ||
                    syncPos + 1 >= packetBuffer.length ||
                    packetBuffer[syncPos + 1] !== 0x62
                  ) {
                    packetBuffer = Buffer.alloc(0);
                    break;
                  }

                  if (syncPos > 0) {
                    packetBuffer = packetBuffer.slice(syncPos);
                  }

                  if (packetBuffer.length < 8) break;

                  const msgClass = packetBuffer[2];
                  const msgId = packetBuffer[3];

                  if (msgClass !== 0xFF || msgId !== 0x01) {
                    packetBuffer = packetBuffer.slice(2);
                    continue;
                  }

                  if (packetBuffer.length < 6) break;

                  const payloadLen = packetBuffer.readUInt16LE(4);
                  const totalLen = 8 + payloadLen + 2;

                  if (packetBuffer.length < totalLen) break;

                  const packet = packetBuffer.slice(0, totalLen);
                  const data = parseRaceBoxLiveData(packet);

                  if (data) {
                    console.log(`✅ Parsed:`, data);

                    if (data.speed_mph > 0) {
                      setLatestMessage(
                        `Speed: ${data.speed_mph.toFixed(1)} MPH\n` +
                        `Lat: ${data.latitude.toFixed(5)}\nLon: ${data.longitude.toFixed(5)}\n` +
                        `Alt (WGS): ${data.altitude_wgs} m\n` +
                        `Heading: ${data.heading.toFixed(1)}°\n` +
                        `G-Force X: ${data.g_force_x.toFixed(2)} Y: ${data.g_force_y.toFixed(2)} Z: ${data.g_force_z.toFixed(2)}\n` +
                        `Gyro X: ${data.gyro_x.toFixed(2)} Y: ${data.gyro_y.toFixed(2)} Z: ${data.gyro_z.toFixed(2)}`
                      );
                    } else {
                      setLatestMessage(`Waiting for valid speed...`);
                    }

                    packetBuffer = packetBuffer.slice(totalLen);
                  } else {
                    packetBuffer = packetBuffer.slice(2);
                  }
                }
              }
            }
          );

          const command = 'START\n';
          const base64Command = Buffer.from(command, 'utf-8').toString('base64');

          await connectedDevice.writeCharacteristicWithResponseForService(
            SERVICE_UUID,
            RX_CHAR_UUID,
            base64Command
          );
          console.log('📤 Sent START command');

        } catch (err) {
          console.error('❌ Connection error:', err);
          setStatus('Connection failed');
        }
      }
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>💻 RaceBox Live Data</Text>
      <Text style={styles.status}>{status}</Text>
      <View style={styles.messageBox}>
        <Text style={styles.message}>{latestMessage || 'Waiting for data...'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  header: { fontSize: 24, fontWeight: 'bold', marginBottom: 10 },
  status: { fontSize: 16, marginBottom: 20 },
  messageBox: { borderWidth: 1, padding: 15, borderRadius: 8, minWidth: 250 },
  message: { fontSize: 14, textAlign: 'center' },
});



// const styles = StyleSheet.create({
//   container: {
//     flex: 1,
//     backgroundColor: '#111',
//     paddingTop: 50,
//     paddingHorizontal: 20,
//   },
//   header: {
//     color: '#00ffcc',
//     fontSize: 22,
//     marginBottom: 10,
//     textAlign: 'center',
//   },
//   status: {
//     color: '#aaa',
//     fontSize: 14,
//     marginBottom: 12,
//     textAlign: 'center',
//   },
//   messageBox: {
//     backgroundColor: '#222',
//     padding: 16,
//     borderRadius: 10,
//     minHeight: 100,
//     justifyContent: 'center',
//   },
//   message: {
//     color: '#fff',
//     fontSize: 16,
//   },
// });


//////////////////////////////////////////////////////////////


// import React, { useEffect, useState } from 'react';
// import {
//   View,
//   Text,
//   StyleSheet,
//   PermissionsAndroid,
//   Platform,
//   ScrollView,
// } from 'react-native';
// import { BleManager } from 'react-native-ble-plx';

// const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
// const RX_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write
// const TX_CHARACTERISTIC_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify

// const manager = new BleManager();

// const App = () => {
//   const [status, setStatus] = useState('Scanning...');
//   const [data, setData] = useState('');

//   useEffect(() => {
//     const startBLE = async () => {
//       if (Platform.OS === 'android') {
//         await PermissionsAndroid.requestMultiple([
//           PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
//           PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
//           PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
//         ]);
//       }

//       manager.startDeviceScan(null, null, async (error, device) => {
//         if (error) {
//           setStatus(`Scan error: ${error.message}`);
//           return;
//         }

//         if (device?.name?.includes('RaceBox Mini S')) {
//           setStatus(`Found: ${device.name}`);
//           manager.stopDeviceScan();

//           try {
//             const connectedDevice = await device.connect();
//             setStatus('Connected to RaceBox');

//             await connectedDevice.discoverAllServicesAndCharacteristics();

//             // Enable notifications from TX
//             connectedDevice.monitorCharacteristicForService(
//               UART_SERVICE_UUID,
//               TX_CHARACTERISTIC_UUID,
//               (error, characteristic) => {
//                 if (error) {
//                   setStatus(`Notification error: ${error.message}`);
//                   return;
//                 }

//                 if (characteristic?.value) {
//                   const decoded = atob(characteristic.value);
//                   setData(prev => `${prev}\n${decoded}`);
//                 }
//               }
//             );

//             // Example command: Get firmware version
//             const command = 'VER\r';
//             const base64Command = btoa(command);
//             await connectedDevice.writeCharacteristicWithResponseForService(
//               UART_SERVICE_UUID,
//               RX_CHARACTERISTIC_UUID,
//               base64Command
//             );
//           } catch (err) {
//             setStatus(`Connection failed: ${err.message}`);
//           }
//         }
//       });
//     };

//     startBLE();

//     return () => {
//       manager.destroy();
//     };
//   }, []);

//   return (
//     <View style={styles.container}>
//       <Text style={styles.status}>{status}</Text>
//       <Text style={styles.label}>RaceBox Data:</Text>
//       <ScrollView style={styles.scroll}>
//         <Text style={styles.data}>{data || 'Waiting for data...'}</Text>
//       </ScrollView>
//     </View>
//   );
// };

// const styles = StyleSheet.create({
//   container: { flex: 1, padding: 16, backgroundColor: '#fff' },
//   status: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
//   label: { fontSize: 16, marginBottom: 6 },
//   scroll: { flex: 1, backgroundColor: '#eee', padding: 10 },
//   data: { fontFamily: 'monospace' },
// });

// export default App;





// import React, { useEffect } from 'react';
// import { View, Text, Button, PermissionsAndroid, Platform } from 'react-native';
// import { BleManager } from 'react-native-ble-plx';
// import { requestBluetoothPermissions } from './ble/permissions';

// const manager = new BleManager();

// export default function App() {
//   useEffect(() => {
//     requestBluetoothPermissions();
//   }, []);

//   const scanForRaceBox = async () => {
//     const permissionGranted = await requestBluetoothPermissions();

//     if (!permissionGranted) {
//       console.log('❌ Bluetooth permissions not granted');
//       return;
//     }

//     manager.startDeviceScan(null, null, (error, device) => {
//       if (error) {
//         console.log('Scan error:', error);
//         return;
//       }

//       console.log('📡 Device:', device.name, device.id);

//       if (device.name && device.name.includes('RaceBox')) {
//         console.log('🎯 Found RaceBox:', device.name, device.id);
//         manager.stopDeviceScan();
//       }
//     });
//   };

//   return (
//     <View style={{ padding: 20 }}>
//       <Text style={{ fontSize: 18, marginBottom: 10 }}>RaceBox Scanner</Text>
//       <Button title="Scan for RaceBox" onPress={scanForRaceBox} />
//     </View>
//   );
// }