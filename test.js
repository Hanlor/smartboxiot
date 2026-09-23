// C:\Users\vankh\smart-box-api\test.js
const BASE_URL = 'http://localhost:3000/api/v1';

async function runBackendTests() {
  console.log("🧪 ===============================================");
  console.log("   BẮT ĐẦU KIỂM THỬ BACKEND SMART-BOX-API GATEWAY");
  console.log("==================================================\n");

  // TEST 1: Kiểm tra định dạng LCD 20x04 & Trạng thái ban đầu
  console.log("1️⃣  Kiểm tra LCD Preview & Trạng thái Lockers...");
  let res = await fetch(`${BASE_URL}/lockers`);
  let data = await res.json();
  const l1Len = data.lcd_preview.line1.length;
  console.log(`   Dòng 1 LCD: "${data.lcd_preview.line1}" (Độ dài: ${l1Len} ký tự)`);
  if (l1Len === 20) {
    console.log("   ✅ ĐÚNG CUẨN: Chuỗi LCD đúng chính xác 20 ký tự.\n");
  } else {
    console.error("   ❌ LỖI: Chuỗi LCD chưa chuẩn 20 ký tự!\n");
  }

  // TEST 2: Kịch bản Deposit Abort (Khách đổi ý không bỏ hàng)
  console.log("2️⃣  Kiểm tra logic Hủy gửi hàng (Deposit Abort)...");
  let createRes = await fetch(`${BASE_URL}/shipments/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender_phone: "0911111111", recipient_phone: "0922222222", locker_id: 1 })
  });
  let createData = await createRes.json();
  console.log(`   Tạo đơn Ô 1 thành công (QR Token: ${createData.qr_token.substring(0, 8)}...)`);

  // Quét QR mở tủ
  await fetch(`${BASE_URL}/shipments/open-deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_id: 1, qr_token: createData.qr_token })
  });

  // Giả lập ESP32 báo: Đóng cửa nhưng KHÔNG có hàng (door_closed: true, has_item: false)
  let abortRes = await fetch(`${BASE_URL}/telemetry/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_id: 1, door_closed: true, has_item: false })
  });
  let abortData = await abortRes.json();
  console.log(`   Kết quả Telemetry sau khi đóng cửa trống: Locker status = ${abortData.current_status}`);
  if (abortData.current_status === 'AVAILABLE') {
    console.log("   ✅ ĐÃ HỦY ĐƠN: Ô 1 tự động trả về AVAILABLE thành công.\n");
  } else {
    console.error("   ❌ LỖI: Ô 1 chưa trả về AVAILABLE!\n");
  }

  // TEST 3: Chống dò OTP (Lockout 15 phút sau 5 lần sai)
  console.log("3️⃣  Kiểm tra Chống dò mã OTP (Lockout 5 lần sai)...");
  const testPhone = "0933333333";
  for (let attempt = 1; attempt <= 5; attempt++) {
    let otpRes = await fetch(`${BASE_URL}/shipments/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_phone: testPhone, otp_code: "000000" })
    });
    
    console.log(`   Thử OTP lần ${attempt}: HTTP Status = ${otpRes.status}`);
    if (attempt === 5 && otpRes.status === 429) {
      let errData = await otpRes.json();
      console.log(`   ✅ KHÓA THÀNH CÔNG: Lần thứ 5 trả về 429 - "${errData.message}"\n`);
    }
  }

  // TEST 4: Khôi phục Dữ liệu (File Persistence)
  console.log("4️⃣  Kiểm tra lưu file state.json...");
  const fs = require('fs');
  const path = require('path');
  const statePath = path.join(__dirname, 'state.json');
  if (fs.existsSync(statePath)) {
    console.log("   ✅ FILE EXIST: Tệp state.json đã tự động được khởi tạo và ghi nhớ dữ liệu.");
  } else {
    console.error("   ❌ LỖI: Không tìm thấy tệp state.json!");
  }

  console.log("\n🎉 HOÀN THÀNH TOÀN BỘ BÀI TEST BACKEND!");
}

runBackendTests().catch(err => console.error(" Lỗi kết nối Server:", err.message));