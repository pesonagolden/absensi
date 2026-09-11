import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  FlatList,
  ActivityIndicator,
  SafeAreaView
} from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Buffer } from 'buffer';

// CONFIGURATION: Ganti sesuai URL dan Kredensial Anda
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzMRsjB_cMUi60rWTwG0yzFbb9LegG5WRFEBV7jOkL47H6pscYCHozC2YvjdePqiZeqgQ/exec";
const NEXTCLOUD_URL = "https://nextcloud.domain-anda.com/remote.php/dav/files/nama_admin/";
const NEXTCLOUD_USER = "nama_admin";
const NEXTCLOUD_PASS = "Bangsat$123";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState('user');
  const [permission, requestPermission] = useCameraPermissions();
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [usersList, setUsersList] = useState([]);
  const cameraRef = useRef(null);

  const [request, response, promptAsync] = Google.useAuthRequest({
    androidClientId: '601429116777:android:0deba5516cac5d9edd9ff8.apps.googleusercontent.com',
    iosClientId: '601429116777:ios:ceaec8d6ee51211add9ff8.apps.googleusercontent.com',
    webClientId: '601429116777:web:e1c06f70ed129cb7dd9ff8.apps.googleusercontent.com',
  });

  useEffect(() => {
    setupNotifications();
    requestLocationPermission();
  }, []);

  useEffect(() => {
    if (response?.type === 'success') {
      const { authentication } = response;
      fetchGoogleUserInfo(authentication.accessToken);
    }
  }, [response]);

  // 1. NOTIFIKASI OTOMATIS (08:30 UNTUK ABSEN IN & 17:30 UNTUK ABSEN OUT)
  const setupNotifications = async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;

    await Notifications.cancelAllScheduledNotificationsAsync();

    // Notifikasi Absen Masuk - Jam 08:30 Setiap Hari Kerja
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Pengingat Absen Masuk",
        body: "Waktu menunjukkan pukul 08:30 WIB. Silakan lakukan Absen Masuk sekarang!",
      },
      trigger: { hour: 8, minute: 30, repeats: true },
    });

    // Notifikasi Absen Pulang & Penarikan Linimasa - Jam 17:30 Every Day
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Pengingat Absen Pulang",
        body: "Waktu menunjukkan pukul 17:30 WIB. Silakan lakukan Absen Pulang dan verifikasi lokasi linimasa Anda!",
      },
      trigger: { hour: 17, minute: 30, repeats: true },
    });
  };

  const requestLocationPermission = async () => {
    let { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      let loc = await Location.getCurrentPositionAsync({});
      setLocation(loc);
    }
  };

  const fetchGoogleUserInfo = async (token) => {
    setLoading(true);
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const userInfo = await res.json();
      setUser(userInfo);
      await loginToBackend(userInfo.email, userInfo.name);
    } catch (err) {
      Alert.alert("Error", "Gagal mengambil data akun Google.");
    } finally {
      setLoading(false);
    }
  };

  const loginToBackend = async (email, name) => {
    try {
      const res = await fetch(GAS_WEB_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "login", email, name }),
      });
      const data = await res.json();
      if (data.status === "success") {
        setRole(data.role);
        if (data.role === 'admin') {
          fetchUsersList();
        }
      }
    } catch (e) {
      Alert.alert("Error System", "Gagal menghubungkan ke database Google Sheets.");
    }
  };

  // 2. INTEGRASI UPLOAD FOTO KE NEXTCLOUD VIA WEBDAV
  const uploadPhotoToNextcloud = async (base64Data, fileName) => {
    const authHeader = 'Basic ' + Buffer.from(`${NEXTCLOUD_USER}:${NEXTCLOUD_PASS}`).toString('base64');
    const uploadUrl = `${NEXTCLOUD_URL}${fileName}`;

    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'image/jpeg',
      },
      body: Buffer.from(base64Data, 'base64'),
    });

    if (res.status === 201 || res.status === 204) {
      return uploadUrl;
    } else {
      throw new Error("Gagal menyimpan foto ke Nextcloud server.");
    }
  };

  // 3. EXECUTION ABSENSI REALTIME WITH TIMESTAMP & LOCATION
  const handleProcessAbsen = async (type) => {
    if (!cameraRef.current) return;
    setLoading(true);

    try {
      // Ambil Posisi GPS Realtime
      let currentLoc = await Location.getCurrentPositionAsync({});
      const locString = `${currentLoc.coords.latitude},${currentLoc.coords.longitude}`;

      // Ambil Foto Realtime dari Kamera Depan
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      const cleanEmail = user.email.replace(/[^a-zA-Z0-9]/g, "_");
      const fileName = `absen_${type}_${cleanEmail}_${Date.now()}.jpg`;

      // Simpan Foto ke Nextcloud
      const photoUrl = await uploadPhotoToNextcloud(photo.base64, fileName);

      // Kirim Data Lengkap ke Google Apps Script / Google Sheets
      const res = await fetch(GAS_WEB_APP_URL, {
        method: 'POST',
        body: JSON.stringify({
          action: "absen",
          email: user.email,
          name: user.name,
          type: type,
          photoUrl: photoUrl,
          location: locString,
          notes: type === 'OUT' ? `Linimasa GPS diambil pada ${new Date().toLocaleTimeString('id-ID')}` : '-'
        }),
      });

      const result = await res.json();
      if (result.status === "success") {
        Alert.alert("Berhasil", `${result.message}\nStatus: ${result.statusAbsen}\nTimestamp: ${result.timestamp}`);
      } else {
        Alert.alert("Gagal Absen", result.message);
      }
    } catch (err) {
      Alert.alert("Error Absensi", err.message);
    } finally {
      setLoading(false);
    }
  };

  // 4. MANAGEMENT ROLE OLEH ADMIN
  const fetchUsersList = async () => {
    try {
      const res = await fetch(`${GAS_WEB_APP_URL}?action=getUsers`);
      const data = await res.json();
      if (data.status === "success") setUsersList(data.users);
    } catch (e) {
      console.error(e);
    }
  };

  const updateUserRole = async (targetEmail, newRole) => {
    setLoading(true);
    try {
      const res = await fetch(GAS_WEB_APP_URL, {
        method: 'POST',
        body: JSON.stringify({ action: "updateRole", targetEmail, newRole }),
      });
      const data = await res.json();
      Alert.alert("Update Success", data.message);
      fetchUsersList();
    } catch (e) {
      Alert.alert("Error", "Gagal memperbarui role karyawan.");
    } finally {
      setLoading(false);
    }
  };

  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={styles.centerContainer}>
        <Text style={{ textAlign: 'center', marginBottom: 15 }}>Aplikasi memerlukan izin akses kamera untuk absensi.</Text>
        <TouchableOpacity style={styles.btnPrimary} onPress={requestPermission}>
          <Text style={styles.btnText}>Izinkan Kamera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.mainTitle}>Sistem Absensi Karyawan</Text>
        <Text style={styles.subTitle}>Silakan login dengan Akun Google Resmi</Text>
        <TouchableOpacity style={styles.btnGoogle} onPress={() => promptAsync()} disabled={!request}>
          <Text style={styles.btnText}>Login dengan Google</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.welcomeText}>Halo, {user.name}</Text>
        <Text style={styles.roleBadge}>Role: {role.toUpperCase()}</Text>
      </View>

      <View style={styles.cameraContainer}>
        <CameraView style={styles.camera} ref={cameraRef} facing="front" />
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={[styles.btnAbsen, { backgroundColor: '#15803d' }]} onPress={() => handleProcessAbsen('IN')} disabled={loading}>
          <Text style={styles.btnText}>Absen Masuk (08:30)</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btnAbsen, { backgroundColor: '#b91c1c' }]} onPress={() => handleProcessAbsen('OUT')} disabled={loading}>
          <Text style={styles.btnText}>Absen Pulang (17:30)</Text>
        </TouchableOpacity>
      </View>

      {loading && <ActivityIndicator size="large" color="#0284c7" style={{ marginVertical: 15 }} />}

      {/* PANEL ADMIN UNTUK MEMILAH & MENGATUR ROLE KARYAWAN */}
      {role === 'admin' && (
        <View style={styles.adminSection}>
          <Text style={styles.adminTitle}>Manajemen Peran Karyawan</Text>
          <FlatList
            data={usersList}
            keyExtractor={(item) => item[0]}
            renderItem={({ item }) => (
              <View style={styles.userCard}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName}>{item[1]}</Text>
                  <Text style={styles.userEmail}>{item[0]}</Text>
                  <Text style={styles.currentRole}>Role: {item[2]}</Text>
                </View>
                <View style={styles.actionButtons}>
                  <TouchableOpacity onPress={() => updateUserRole(item[0], 'operator')} style={styles.btnRole}>
                    <Text style={styles.btnRoleText}>Operator</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => updateUserRole(item[0], 'admin')} style={[styles.btnRole, { backgroundColor: '#0369a1' }]}>
                    <Text style={[styles.btnRoleText, { color: '#fff' }]}>Admin</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => updateUserRole(item[0], 'user')} style={styles.btnRole}>
                    <Text style={styles.btnRoleText}>User</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc', paddingHorizontal: 20 },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  mainTitle: { fontSize: 24, fontWeight: 'bold', color: '#0f172a', marginBottom: 5 },
  subTitle: { fontSize: 14, color: '#64748b', marginBottom: 25 },
  header: { marginTop: 20, marginBottom: 15, alignItems: 'center' },
  welcomeText: { fontSize: 20, fontWeight: 'bold', color: '#1e293b' },
  roleBadge: { fontSize: 12, fontWeight: '700', color: '#0369a1', marginTop: 4, backgroundColor: '#e0f2fe', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  cameraContainer: { width: 220, height: 220, borderRadius: 110, overflow: 'hidden', alignSelf: 'center', marginVertical: 15, borderWidth: 3, borderColor: '#0284c7' },
  camera: { flex: 1 },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 10 },
  btnAbsen: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: '#0284c7', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  btnGoogle: { backgroundColor: '#2563eb', paddingVertical: 14, paddingHorizontal: 32, borderRadius: 10 },
  btnText: { color: '#ffffff', fontWeight: 'bold', fontSize: 14 },
  adminSection: { flex: 1, marginTop: 20, borderTopWidth: 1, borderColor: '#e2e8f0', paddingTop: 15 },
  adminTitle: { fontSize: 16, fontWeight: 'bold', color: '#0f172a', marginBottom: 10 },
  userCard: { backgroundColor: '#ffffff', padding: 12, borderRadius: 8, marginBottom: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#f1f5f9' },
  userName: { fontWeight: 'bold', fontSize: 14, color: '#1e293b' },
  userEmail: { fontSize: 12, color: '#64748b' },
  currentRole: { fontSize: 11, color: '#0369a1', marginTop: 2, fontWeight: '600' },
  actionButtons: { flexDirection: 'row', gap: 4 },
  btnRole: { backgroundColor: '#f1f5f9', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  btnRoleText: { fontSize: 10, fontWeight: 'bold', color: '#334155' }
});
