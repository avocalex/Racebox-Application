import { PermissionsAndroid, Platform } from 'react-native';

export async function requestBluetoothPermissions() {
  if (Platform.OS === 'android' && Platform.Version >= 31) {
    try {
      const granted = await PermissionsAndroid.requestMultiple([
        {
          name: PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          message: 'RaceBox needs access to scan for BLE devices.',
          title: 'Bluetooth Scan Permission',
        },
        {
          name: PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          message: 'RaceBox needs access to connect to your BLE devices.',
          title: 'Bluetooth Connect Permission',
        },
        {
          name: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          message: 'RaceBox needs access to location for BLE scanning.',
          title: 'Location Permission',
        },
      ]);

      return (
        granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED
      );
    } catch (err) {
      console.warn('Permission request failed', err);
      return false;
    }
  }

  return true;
}