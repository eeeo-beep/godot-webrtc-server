/*
 * Bu, Godot WebRTC demoları için bir sinyal sunucusudur (Node.js versiyonu).
 * GDScript versiyonuyla (ws_webrtc_server.gd) tamamen aynı protokolü kullanır.
 *
 * Varsayılan olarak 9080 portunu dinler. Portu değiştirmek için:
 * "node server.js 1234" veya "PORT=1234 node server.js"
 */

const { WebSocketServer } = require('ws'); // 'ws' kütüphanesini dahil et

const PORT = process.env.PORT || 9080; // Sunucunun çalışacağı port
const LOBBY_TIMEOUT = 10000; // Mühürlenmiş (sealed) lobilerin kapanma süresi (ms)
const PEER_TIMEOUT = 1000; // Yanıt vermeyen peer'lerin zaman aşımı süresi (ms)
const ALFNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const lobbies = new Map(); // Aktif lobileri (odaları) tutar
const peers = new Map(); // Bağlı olan tüm oyuncuları (peer) tutar
let nextPeerId = 1; // Oyunculara verilecek benzersiz ID

// Rastgele Lobi ID'si oluşturma fonksiyonu
function genLobbyId() {
	let id = '';
	for (let i = 0; i < 5; i += 1) { // 5 karakterli bir ID oluştur
		id += ALFNUM.charAt(Math.floor(Math.random() * ALFNUM.length));
	}
	return id;
}

// Bir oyuncuya (peer) JSON formatında mesaj gönderme fonksiyonu
function send(peer, msg) {
	if (peer.ws.readyState !== 1) { // 1 = STATE_OPEN
		console.log(`Uyarı: Peer ${peer.id} için WebSocket kapalı. Mesaj gönderilemedi.`);
		return;
	}
	const str = JSON.stringify(msg);
	peer.ws.send(str);
}

// Bir oyuncuyu (peer) lobiden çıkaran fonksiyon
function leaveLobby(peer) {
	const { lobby } = peer;
	if (lobby === null) return; // Zaten bir lobide değilse bir şey yapma

	console.log(`Peer ${peer.id} lobiden ayrılıyor: ${lobby.id}`);
	lobby.peers.delete(peer.id); // Oyuncuyu lobinin listesinden sil
	peer.lobby = null;

	let closeLobby = false; // Lobi kapatılmalı mı?
	if (peer.id === lobby.host) {
		// Eğer ayrılan kişi lobinin kurucusu (host) ise, lobi kapanır.
		console.log(`Lobi kurucusu ${peer.id} ayrıldı. Lobi ${lobby.id} kapatılıyor.`);
		closeLobby = true;
	}

	if (lobby.sealed) {
		// Lobi mühürlüyse ve biri ayrıldıysa, lobi kapanır (host olmasa bile).
		lobbies.delete(lobby.id);
		return; // Diğerlerine haber vermeye gerek yok, lobi zaten kapandı.
	}

	// Lobide kalan diğer oyunculara bu oyuncunun ayrıldığını haber ver
	lobby.peers.forEach((p) => {
		if (closeLobby) {
			// Eğer lobi kapanıyorsa (host ayrıldıysa), herkesi at
			p.ws.close(1000, 'Lobby closed');
		} else {
			// Sadece bu oyuncunun ayrıldığını bildir
			send(p, {
				type: 3, // PEER_DISCONNECT
				id: peer.id,
				data: '',
			});
		}
	});

	if (closeLobby) {
		lobbies.delete(lobby.id); // Lobiyi haritadan sil
	}
}

// Gelen JSON mesajını işleyen fonksiyon
function parseMsg(peer, msg) {
	let obj = null;
	try {
		obj = JSON.parse(msg); // Mesajı JSON olarak çözmeyi dene
	} catch (e) {
		console.error(`Hata: Peer ${peer.id}'den gelen mesaj JSON formatında değil: ${msg}`);
		return false;
	}

	// Mesajın beklenen formatta olduğundan emin ol
	if (obj.type === undefined || obj.id === undefined || obj.data === undefined) {
		console.error(`Hata: Peer ${peer.id}'den geçersiz mesaj formatı.`);
		return false;
	}

	const { type, id, data } = obj;
	const { lobby } = peer;

	if (peer.lobby === null) {
		// Oyuncu henüz bir lobide değilse, sadece 'JOIN' mesajı gönderebilir
		if (type !== 0) { // 0 = JOIN
			console.error(`Hata: Lobide olmayan Peer ${peer.id} 'JOIN' dışında bir mesaj gönderdi.`);
			return false;
		}

		// Lobiye katılma veya yeni lobi oluşturma
		const useMesh = id === 0; // id 0 ise Mesh (herkes herkese bağlı) modu
		let newLobby = data;
		if (newLobby === '') {
			// Lobi ID'si verilmediyse, rastgele yeni bir ID oluştur
			do {
				newLobby = genLobbyId();
			} while (lobbies.has(newLobby));
			// Yeni lobiyi oluştur
			lobbies.set(newLobby, {
				id: newLobby,
				host: peer.id,
				peers: new Map(),
				sealed: false,
				mesh: useMesh,
				time: Date.now(),
			});
			console.log(`Peer ${peer.id} yeni lobi oluşturdu: ${newLobby}`);
		}

		const joinedLobby = lobbies.get(newLobby);
		if (joinedLobby === undefined) {
			// Katılmaya çalışılan lobi bulunamadı
			console.error(`Hata: Peer ${peer.id} var olmayan lobiye katılmaya çalıştı: ${newLobby}`);
			return false;
		}
		if (joinedLobby.sealed) {
			// Lobi mühürlenmiş (kilitli)
			console.error(`Hata: Peer ${peer.id} mühürlü lobiye katılmaya çalıştı: ${newLobby}`);
			return false;
		}

		console.log(`Peer ${peer.id} lobiye katıldı: ${newLobby}`);
		peer.lobby = joinedLobby;

		// Yeni katılan oyuncuya ID'sini ve mesh modunu bildir
		// Not: Host'un ID'si her zaman 1 olarak ayarlanır (istemci tarafında)
		send(peer, {
			type: 1, // ID
			id: (peer.id === joinedLobby.host ? 1 : peer.id),
			data: joinedLobby.mesh ? 'true' : '',
		});

		// Lobideki diğer oyunculara yeni birinin katıldığını haber ver
		joinedLobby.peers.forEach((p) => {
			if (p.id === peer.id) return; // Kendisine gönderme
			// Mesh modunda değilse, sadece host'a haber ver
			if (!joinedLobby.mesh && p.id !== joinedLobby.host) {
				return;
			}
			send(p, {
				type: 2, // PEER_CONNECT
				id: peer.id,
				data: '',
			});
			// Yeni oyuncuya da lobideki diğer oyuncuları bildir
			send(peer, {
				type: 2, // PEER_CONNECT
				id: (p.id === joinedLobby.host ? 1 : p.id),
				data: '',
			});
		});
		// Yeni oyuncuyu lobinin listesine ekle
		joinedLobby.peers.set(peer.id, peer);

		// Oyuncuya lobiye başarıyla katıldığını bildir
		send(peer, {
			type: 0, // JOIN
			id: 0,
			data: newLobby,
		});

		return true; // Mesaj başarıyla işlendi
	}

	// --- Oyuncu zaten bir lobideyse ---

	if (type === 7) { // 7 = SEAL (Lobiyi mühürle)
		if (lobby.host !== peer.id) {
			console.error(`Hata: Sadece host (${lobby.host}) lobiyi mühürleyebilir. Peer ${peer.id} denedi.`);
			return false; // Sadece host lobiyi mühürleyebilir
		}
		console.log(`Lobi ${lobby.id} mühürlendi (Peer ${peer.id} tarafından).`);
		lobby.sealed = true;
		lobby.time = Date.now();
		// Lobideki herkese mühürlendiğini bildir
		lobby.peers.forEach((p) => {
			send(p, { type: 7, id: 0, data: '' });
		});
		return true;
	}

	// Diğer mesaj türleri (OFFER, ANSWER, CANDIDATE)
	// Bu mesajlar sadece bir oyuncudan diğerine iletilir (forwarding)

	let destId = id; // Hedef oyuncunun ID'si
	if (destId === 1) destId = lobby.host; // ID 1 ise, hedef host'tur

	const destPeer = peers.get(destId);
	if (destPeer === undefined) {
		console.error(`Hata: Hedef peer ${destId} bulunamadı (Gönderen: ${peer.id}).`);
		return false;
	}
	if (destPeer.lobby !== lobby) {
		console.error(`Hata: Peer ${peer.id}, farklı lobideki ${destId} peer'ine mesaj göndermeye çalıştı.`);
		return false;
	}

	// Kaynak ID'yi ayarla (eğer gönderen host ise ID'si 1 olmalı)
	const sourceId = (peer.id === lobby.host ? 1 : peer.id);

	if (type === 4 || type === 5 || type === 6) { // 4=OFFER, 5=ANSWER, 6=CANDIDATE
		// WebRTC sinyal mesajlarını hedefe ilet
		send(destPeer, {
			type,
			id: sourceId,
			data,
		});
		return true;
	}

	console.error(`Hata: Bilinmeyen mesaj tipi ${type} (Peer ${peer.id}).`);
	return false;
}

// Zaman aşımlarını kontrol eden periyodik fonksiyon
function checkTimeouts() {
	const now = Date.now();

	// Lobileri kontrol et
	lobbies.forEach((lobby) => {
		if (!lobby.sealed) return;
		if (lobby.time + LOBBY_TIMEOUT > now) return; // Henüz zamanı gelmemiş

		// Mühürlü lobinin zamanı doldu, herkesi at
		console.log(`Mühürlü lobi ${lobby.id} zaman aşımına uğradı. Kapatılıyor.`);
		lobby.peers.forEach((p) => {
			p.ws.close(1000, 'Lobby sealed timeout');
		});
		lobbies.delete(lobby.id);
	});

	// Oyuncuları (peer) kontrol et
	peers.forEach((peer) => {
		if (peer.lobby !== null) return; // Zaten lobideyse zaman aşımı yok
		if (peer.time + PEER_TIMEOUT > now) return; // Henüz zamanı gelmemiş

		// Lobisi olmayan (JOIN atmamış) peer zaman aşımına uğradı
		console.log(`Peer ${peer.id} (lobisiz) zaman aşımına uğradı. Bağlantı kesiliyor.`);
		peer.ws.close(1000, 'Lobby join timeout');
		// Not: 'close' event'i tetiklendiğinde peer haritadan silinecek
	});
}

// Zaman aşımı kontrolünü her 5 saniyede bir çalıştır
setInterval(checkTimeouts, 5000);

// Ana WebSocket sunucusunu başlat
const wss = new WebSocketServer({ port: PORT });
console.log(`Sinyal sunucusu ${PORT} portunda başlatıldı...`);

wss.on('connection', (ws) => {
	// Yeni bir oyuncu bağlandığında
	const peerId = nextPeerId;
	nextPeerId += 1;

	console.log(`Peer ${peerId} bağlandı.`);

	// Yeni Peer nesnesini oluştur
	const peer = {
		id: peerId,
		ws,
		lobby: null, // Başlangıçta lobisi yok
		time: Date.now(), // Zaman aşımı takibi için
	};
	peers.set(peerId, peer); // Yeni peer'i ana haritaya ekle

	// Mesaj geldiğinde (ws.on('message'))
	ws.on('message', (message) => {
		peer.time = Date.now(); // Peer hayatta olduğunu belirtti
		if (!parseMsg(peer, message.toString())) {
			// Mesaj işlenemezse veya geçersizse, bağlantıyı kapat
			console.log(`Peer ${peerId}'den gelen mesaj işlenemedi. Bağlantı kesiliyor.`);
			ws.close(1009, 'Invalid message'); // 1009 = Policy Violation
		}
	});

	// Bağlantı kapandığında (ws.on('close'))
	ws.on('close', (code, reason) => {
		console.log(`Peer ${peerId} bağlantısı kesildi. Kod: ${code}, Neden: ${reason.toString()}`);
		if (peer.lobby) {
			leaveLobby(peer); // Eğer bir lobideyse, lobiden çıkar
		}
		peers.delete(peerId); // Peer'i ana haritadan sil
	});

	// Hata oluştuğunda (ws.on('error'))
	ws.on('error', (error) => {
		console.error(`Peer ${peerId} için WebSocket hatası: ${error}`);
		if (peer.lobby) {
			leaveLobby(peer); // Hata durumunda lobiden çıkar
		}
		peers.delete(peerId); // Peer'i ana haritadan sil
		ws.close(1011, 'Server error'); // 1011 = Internal Error
	});
});
