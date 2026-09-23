// C:\Users\vankh\smart-box-api\mock-esp32.js
const SERVER_URL = 'http://127.0.0.1:3000/api/v1';

console.log("🤖 [ESP32 MOCK] Đã khởi động! Đang kết nối tới Backend...");

// 1. Giả lập ESP32 đọc cảm biến và gửi Telemetry báo trạng thái tủ
async function sendTelemetry(lockerId, doorClosed, hasItem) {
  try {
    const res = await fetch(`${SERVER_URL}/telemetry/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locker_id: lockerId, door_closed: doorClosed, has_item: hasItem })
    });
    const data = await res.json();
    console.log(`📡 [ESP32 Telemetry] Báo Cửa:${doorClosed ? 'Đóng' : 'Mở'} | Hàng:${hasItem ? 'Có' : 'Không'} => Server trả về status: ${data.current_status}`);
  } catch (err) {
    console.error("❌ [ESP32 Error] Không kết nối được Server!");
  }
}

// 2. Giả lập ESP32 Polling 1 giây/lần để kiểm tra lệnh mở Servo từ Backend
setInterval(async () => {
  try {
    const res = await fetch(`${SERVER_URL}/lockers`);
    const data = await res.json();
    
    data.lockers.forEach(locker => {
      // Nếu Backend báo đang ở trạng thái DEPOSITING hoặc PICKING (cần mở chốt)
      if (locker.status === 'DEPOSITING' || locker.status === 'PICKING') {
        console.log(`🔓 [ESP32 SERVO] Nhận lệnh MỞ CỬA Ô SỐ ${locker.locker_id}! (Quay Servo 90 độ)`);
      }
    });
  } catch (e) {}
}, 1500);

// Giả lập sau 3 giây: Người gửi bỏ hàng vào Ô 1 và đóng cửa lại
setTimeout(() => {
  console.log("\n📦 [Hành động] Người gửi bỏ hàng vào Ô 1 và ĐÓNG CỬA...");
  sendTelemetry(1, true, true);
}, 3000);