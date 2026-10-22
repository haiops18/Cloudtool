# Hướng dẫn: Đẩy tài nguyên đã cấp phát vào Dolphin bằng API

Tài liệu dành cho nhân sự cấp phát/thu hồi tài nguyên Public Cloud bằng công cụ riêng,
cần đẩy máy chủ vào **Danh sách tài nguyên** của Dolphin để quản lý chung.

---

# Phần A - LẤY KHOÁ API

Công cụ chạy ngoài Dolphin không tự đăng nhập được bằng tài khoản Viettel (đó là luồng đăng nhập qua trình duyệt). Thay vào đó, **bạn đăng nhập Dolphin như thường ngày rồi tự phát một khoá riêng cho công cụ**. Mọi thao tác công cụ thực hiện sẽ được ghi **đích danh tên bạn**, quyền đúng bằng quyền bạn đang có trên Dolphin.

## A1. Các bước lấy khoá

1. Đăng nhập Dolphin bằng tài khoản Viettel như thường ngày.
2. Vào menu **QL Tài nguyên**.
3. Chọn tab **Khoá API** (nằm cạnh các tab Danh sách tài nguyên / Cấp phát / Thu hồi / Báo cáo).
4. Điền **Tên gợi nhớ**, ví dụ: `công cụ cấp phát Cloud - máy trạm của Nam`.
5. Chọn **thời hạn**: mặc định 90 ngày. Chọn ngắn nếu chỉ dùng cho một đợt việc.
6. Bấm **Tạo khoá mới**.
7. Một ô màu vàng hiện ra kèm chuỗi khoá. Bấm **Chép** và dán ngay vào nơi công cụ đọc cấu hình.

> ⚠️ **Chuỗi khoá chỉ hiện đúng một lần.** Rời khỏi màn hình là không xem lại được.
> Nếu lỡ mất: bấm **Thu hồi** khoá cũ rồi tạo khoá mới. Không có cách khôi phục và
> cũng không ai xem hộ được — hệ thống chỉ lưu bản mã hoá của khoá.

Không thấy tab **Khoá API**: vai trò của bạn chưa được phép. Liên hệ quản trị Dolphin để cấp đúng vai trò trước.

## A2. Giữ khoá cho đúng

| Nên | Không nên |
|---|---|
| Mỗi người một khoá riêng | Gửi khoá của mình cho người khác dùng chung |
| Đặt tên gợi nhớ rõ máy nào, việc gì | Để tên trống rồi quên khoá nào của việc nào |
| Đặt thời hạn ngắn nhất đủ dùng | Chọn "Không đặt hạn" cho tiện |
| Lưu vào file cấu hình chỉ mình đọc được | Dán khoá vào chat nhóm, mail, tài liệu dùng chung |
| Thu hồi ngay khi đổi máy, hết việc, nghi lộ | Để khoá cũ sống mãi vì "vẫn đang chạy" |

Vì mọi thao tác ghi tên bạn, **ai mượn được khoá của bạn thì hệ thống vẫn ghi là bạn làm**.

## A3. Khoá tự hết hiệu lực khi nào

- Hết thời hạn đã chọn.
- Bạn bấm **Thu hồi**.
- Tài khoản Dolphin của bạn bị tắt hoặc hết hạn (ví dụ nghỉ việc, chuyển bộ phận).
- Vai trò của bạn bị đổi xuống mức không được sửa tài nguyên.

Không cần nhớ dọn thủ công trong các trường hợp trên — khoá chết theo tài khoản.

## A4. Theo dõi khoá

Bảng trong tab **Khoá API** cho biết mỗi khoá: trạng thái, ngày hết hạn, **lần dùng gần nhất**, **IP gọi đến**, và **tổng số lượt gọi**. Nếu thấy lượt gọi hoặc IP lạ so với thực tế bạn chạy, **thu hồi ngay** rồi tạo khoá mới.

---

# PHẦN B — GỌI API

## B1. Địa chỉ và xác thực

| Mục | Giá trị |
|---|---|
| Địa chỉ | `http://10.254.144.144:8191/api/noc/resource-ingest` |
| Method | `POST` để đẩy dữ liệu, `GET` để kiểm tra kết nối |
| Header bắt buộc | `X-Dolphin-Key: <chuỗi khoá>` |
| Header khi POST | thêm `Content-Type: application/json` |
| Giới hạn | tối đa 500 bản ghi mỗi lần gọi |

Kiểm tra khoá trước khi đẩy thật:

```bash
curl -s http://10.254.144.144:8191/api/noc/resource-ingest \
  -H "X-Dolphin-Key: <chuỗi khoá>"
```

Trả về:

```json
{"ok":true,"service":"dolphin-resource-ingest","auth_mode":"user_key",
 "identity":{"username":"tenban","role_code":"INCIDENT_OPERATOR","key_label":"..."},
 "actions":["allocate","revoke","lookup"],"max_items":500}
```

Phần `identity` cho biết Dolphin đang nhận khoá là của ai — kiểm tra đúng tên mình trước khi chạy thật, nhất là khi công cụ chạy trên máy dùng chung.

## B2. Ba hành động

| action | Ý nghĩa |
|---|---|
| `allocate` | Cấp phát: thêm mới, hoặc cập nhật đè nếu máy đó đã đẩy lên trước đó |
| `revoke` | Thu hồi: chuyển sang trạng thái `RETIRED`, **giữ nguyên bản ghi** để tra lịch sử |
| `lookup` | Tra cứu: xem Dolphin đang giữ thông tin gì về máy đó |

Đặt `action` ở ngoài cùng cho cả lô, hoặc đặt riêng trong từng bản ghi nếu một lần gọi vừa cấp phát vừa thu hồi.

## B3. Chống trùng — phần quan trọng nhất

Mỗi máy được nhận diện bằng **`source` + `external_id`**:

- `source`: tên công cụ, ví dụ `cong-cu-cap-phat`. **Đặt cố định, không đổi qua lại.**
- `external_id`: mã định danh máy **theo công cụ của bạn**. Bắt buộc, phải ổn định theo vòng đời của máy.

Gọi lại nhiều lần với cùng `external_id` sẽ **cập nhật đúng bản ghi cũ**, kể cả khi đã đổi tên VM hay đổi IP. Nhờ vậy công cụ retry thoải mái mà không nhân đôi danh sách.

> Nếu mỗi lần chạy lại sinh `external_id` mới (ví dụ lấy theo thời điểm chạy) thì Dolphin
> sẽ hiểu là máy khác và danh sách sẽ phình ra bản ghi trùng. Hãy lấy mã ổn định từ chính
> hệ thống cấp phát.

## B4. Các trường của một bản ghi

**Bắt buộc:**

| Trường | Ghi chú |
|---|---|
| `external_id` | Mã định danh máy theo công cụ của bạn |
| `system_name` | Tên hệ thống. Chưa có trong danh mục Dolphin thì **tự tạo mới** (xem cảnh báo ở B7). Có thể thay bằng `system_id` nếu biết id. |
| Ít nhất một trong `vm_name`, `management_ip`, `private_ip`, `public_ip`, `vip_ip` | Không có gì trong nhóm này thì bản ghi bị từ chối |

**Tuỳ chọn:** `vcpu`, `ram_gb`, `storage_total_gb`, `storage_detail`, `os_name`,
`owner_unit`, `product_owner`, `deployment_site`, `deployment_position`, `project_name`,
`system_code`.

Một trường IP có thể chứa nhiều giá trị, cách nhau bằng dấu phẩy.

## B5. Ví dụ

**Cấp phát 2 máy:**

```bash
curl -s -X POST http://10.254.144.144:8191/api/noc/resource-ingest \
  -H "X-Dolphin-Key: <chuỗi khoá>" \
  -H "Content-Type: application/json" -d '{
  "source": "cong-cu-cap-phat",
  "action": "allocate",
  "items": [
    {
      "external_id": "VM-2026-0912",
      "system_name": "Ten He Thong ABC",
      "vm_name": "abc-app-01",
      "management_ip": "10.x.x.11",
      "vcpu": 8, "ram_gb": 16, "storage_total_gb": 200,
      "os_name": "Ubuntu 22.04",
      "owner_unit": "Trung tam XYZ",
      "product_owner": "nguoi-phu-trach",
      "deployment_site": "PUBLIC_CLOUD",
      "deployment_position": "Cloud North"
    },
    {
      "external_id": "VM-2026-0913",
      "system_name": "Ten He Thong ABC",
      "vm_name": "abc-db-01",
      "management_ip": "10.x.x.12",
      "vcpu": 16, "ram_gb": 64, "storage_total_gb": 1000
    }
  ]
}'
```

**Thu hồi:**

```bash
curl -s -X POST http://10.254.144.144:8191/api/noc/resource-ingest \
  -H "X-Dolphin-Key: <chuỗi khoá>" \
  -H "Content-Type: application/json" -d '{
  "source": "cong-cu-cap-phat",
  "action": "revoke",
  "items": [{"external_id": "VM-2026-0912"}]
}'
```

**Gọi bằng Python:**

```python
import json, os, urllib.request

KEY = os.environ["DOLPHIN_API_KEY"]          # đọc từ biến môi trường, đừng ghi thẳng vào code
URL = "http://10.254.144.144:8191/api/noc/resource-ingest"

def day_tai_nguyen(items, action="allocate"):
    body = {"source": "cong-cu-cap-phat", "action": action, "items": items}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Dolphin-Key", KEY)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

ket_qua = day_tai_nguyen([{
    "external_id": "VM-2026-0912",
    "system_name": "Ten He Thong ABC",
    "vm_name": "abc-app-01",
    "management_ip": "10.x.x.11",
    "vcpu": 8, "ram_gb": 16,
}])

for r in ket_qua["results"]:                  # LUÔN đọc results, đừng chỉ nhìn HTTP code
    if r["status"] == "error":
        print("LỖI", r["external_id"], "-", r["error"])
```

## B6. Đọc kết quả trả về

```json
{
  "ok": true,
  "auth_mode": "user_key",
  "summary": {"created": 1, "updated": 1, "retired": 0, "not_found": 0, "error": 0, "found": 0},
  "results": [
    {"external_id": "VM-2026-0912", "action": "allocate", "status": "created",
     "vm_id": 4258, "system_id": 1176, "system_name": "Ten He Thong ABC", "system_created": true}
  ]
}
```

| `status` của từng bản ghi | Nghĩa là |
|---|---|
| `created` | Đã thêm mới vào danh sách tài nguyên |
| `updated` | Máy đã có, thông tin được cập nhật đè |
| `retired` | Đã chuyển sang trạng thái thu hồi |
| `found` | Kết quả của `lookup` |
| `not_found` | Không có máy nào ứng với `external_id` đó |
| `error` | Bản ghi này hỏng, xem trường `error` đi kèm |

**Quan trọng:** `ok: false` nghĩa là có ít nhất một bản ghi lỗi, **các bản ghi còn lại vẫn được ghi nhận bình thường**. Công cụ phải đọc `results` để biết bản nào hỏng, không được chỉ nhìn HTTP code rồi kết luận cả lô thất bại và đẩy lại toàn bộ.

## B7. Cảnh báo về `system_created`

Khi kết quả có `"system_created": true`, nghĩa là Dolphin **vừa tạo mới một hệ thống** trong danh mục vì chưa tìm thấy tên bạn gửi lên.

Nếu mỗi người gõ tên hệ thống một kiểu (`Portal Y Te`, `Portal Y Tế`, `portal-yte`), danh mục sẽ sinh ra nhiều bản ghi cho cùng một hệ thống và phải gộp lại rất mất công. Vì vậy:

- Thống nhất trước một danh sách tên hệ thống chuẩn, dùng đúng tên đó.
- Thấy `system_created: true` mà bạn biết hệ thống đã tồn tại → **báo lại ngay** để sửa tên trước khi đẩy tiếp.

## B8. Lỗi hay gặp và cách xử lý

Thông báo lỗi trong cột đầu là chuỗi **không dấu** đúng như API trả về, để tra cho khớp.

| Hiện tượng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| HTTP **403** | Khoá sai, gõ thiếu ký tự, đã thu hồi, hết hạn, hoặc vai trò không đủ quyền | Gọi `GET` để kiểm tra khoá. Vẫn 403 thì tạo khoá mới. |
| HTTP **403** dù khoá vừa tạo | Gửi sai tên header | Header phải đúng là `X-Dolphin-Key` |
| HTTP **400** | Cấu trúc gói tin sai, `items` không phải mảng, hoặc gửi quá 500 bản ghi | Chia nhỏ lô, kiểm tra lại JSON |
| `thieu external_id` | Bản ghi không có mã định danh | Bổ sung `external_id` |
| `thieu system_name (hoac system_id)` | Không gửi tên hệ thống và cũng không gửi `system_id` | Bổ sung một trong hai |
| `phai co vm_name hoac it nhat mot IP` | Bản ghi rỗng thông tin máy | Bổ sung tên VM hoặc IP |
| `status: not_found` khi thu hồi | `external_id` không khớp cái đã dùng lúc cấp phát, hoặc `source` bị đổi | Dùng `lookup` để đối chiếu; giữ `source` cố định |
| Danh sách bị trùng máy | `external_id` thay đổi giữa các lần chạy | Sửa công cụ để lấy mã ổn định (xem B3) |
| HTTP **500** | Lỗi phía Dolphin | Ghi lại thời điểm và nội dung gói tin rồi báo bộ phận quản trị Dolphin |

## B9. Đối soát định kỳ

Trước các đợt rà soát, dùng `lookup` để so hai bên:

```bash
curl -s -X POST http://10.254.144.144:8191/api/noc/resource-ingest \
  -H "X-Dolphin-Key: <chuỗi khoá>" \
  -H "Content-Type: application/json" \
  -d '{"source":"cong-cu-cap-phat","action":"lookup","items":[{"external_id":"VM-2026-0912"}]}'
```

Máy còn chạy thật nhưng Dolphin trả `not_found` → đẩy lại bằng `allocate`.
Máy đã thu hồi thật nhưng Dolphin còn `ACTIVE` → gọi `revoke`.

---

## Ghi nhớ nhanh

1. Khoá là của riêng bạn, mọi thao tác ghi tên bạn.
2. Chuỗi khoá chỉ hiện một lần lúc tạo.
3. `external_id` phải ổn định — đây là thứ chống trùng danh sách.
4. Thu hồi không xoá dữ liệu, chỉ chuyển trạng thái.
5. Luôn đọc `results`, đừng chỉ nhìn HTTP code.
6. Thấy `system_created: true` bất thường thì dừng lại kiểm tra tên hệ thống.
