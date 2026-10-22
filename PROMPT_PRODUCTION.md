# Prompt production: Cloud Project Operations Web App

Bạn là một kỹ sư full-stack senior. Hãy xây dựng hoàn chỉnh một web application production-ready để vận hành tài nguyên cloud theo yêu cầu dưới đây. Không chỉ tạo UI mẫu: phải triển khai đầy đủ frontend, backend, cơ sở dữ liệu, tích hợp Cloud API theo tài liệu có sẵn, kiểm thử, cấu hình và tài liệu chạy ứng dụng.

## 1. Bối cảnh và nguồn tham chiếu bắt buộc

Làm việc trực tiếp trong workspace hiện có. Trước khi viết code, hãy đọc kỹ các nguồn sau và dùng chúng làm nguồn chân lý:

- `TemplateWeb/`: template frontend cần kế thừa phong cách, cấu trúc component, design system và các dependency đang có. Toàn bộ ứng dụng frontend mới phải nằm trong `frontend/`; không sửa template trừ khi thực sự cần thiết.
- `APIdoc/API_info_project.txt`, `APIdoc/API_Network.txt`, `APIdoc/API_share_project.txt`: đặc tả Cloud API. Hãy lập inventory endpoint, method, URL, headers, request body, response và lỗi trước khi cài đặt integration. Chỉ dùng endpoint, trường dữ liệu và quy tắc có trong tài liệu. Không tự bịa API; nếu thiếu thông tin cần thiết, tạo một adapter/interface rõ ràng, ghi TODO có ngữ cảnh và nêu chính xác điểm thiếu trong `README`.
- `frontend/`: toàn bộ TypeScript frontend.
- `backend/`: toàn bộ Python backend.
- `data/`: SQLite database, migration/seed cần thiết và tuyệt đối không commit dữ liệu bí mật.

Không phá hủy các file hoặc thay đổi đang tồn tại. Trước khi sửa, kiểm tra cấu trúc repository hiện có để tích hợp phù hợp.

Trước khi cài đặt, tạo bảng mapping tài liệu API trong README hoặc tài liệu kiến trúc, tối thiểu gồm: tên nghiệp vụ, method/path, có/không cần `project-id`, request schema, response/status thành công, pagination, mutation/idempotency, dữ liệu nhạy cảm và adapter triển khai. Phân biệt rõ dữ liệu ví dụ trong tài liệu với cấu hình production; không hard-code UUID/project/VPC mẫu vào business logic.

Nếu yêu cầu trong prompt, template và API docs xung đột, ưu tiên theo thứ tự: an toàn bảo mật và không mất dữ liệu; API docs cho contract upstream; yêu cầu nghiệp vụ trong prompt; convention của template. Mọi xung đột hoặc giả định ảnh hưởng hành vi phải được ghi rõ trong README, không âm thầm suy đoán.

## 2. Mục tiêu và nguyên tắc kiến trúc

Ứng dụng là lớp vận hành giữa người dùng và Cloud API:

`React frontend -> Python backend/API gateway -> Cloud API`

- Frontend không được gọi Cloud API trực tiếp.
- Backend là điểm duy nhất gọi Cloud API; mọi luồng Cloud API phải đi qua một Cloud API client/gateway dùng chung.
- Tất cả thao tác định danh tài nguyên phải dùng ID (`project_id`, `server_id`, `ip_id`, ...), không map hoặc cập nhật bằng tên.
- Ưu tiên bảo mật, tính đúng đắn, quan sát được và phản hồi rõ ràng hơn việc tối ưu số lượng tính năng.
- Ứng dụng phải responsive, accessible cơ bản, có loading/empty/error state và không để thao tác nguy hiểm xảy ra im lặng.
- Các batch mutation phải có kết quả độc lập theo từng item, giới hạn concurrency, progress rõ ràng và khả năng retry có chủ đích chỉ với item thất bại. Không được chạy `Promise.all`/task không giới hạn làm quá tải Cloud API hoặc SQLite.
- Kiểm tra quyền sở hữu project/resource và các điều kiện zone/subnet ở backend ngay trước mutation để tránh TOCTOU; validation ở frontend chỉ nhằm cải thiện UX, không phải ranh giới bảo mật.

## 3. Stack và cấu trúc yêu cầu

### Frontend

- TypeScript strict, React và Vite, tái sử dụng các dependency/phong cách phù hợp trong `TemplateWeb`.
- Dùng React Query cho server state, React Hook Form + Zod cho form validation, TanStack Table cho datatable, và hệ thống component hiện có trong template khi khả dụng.
- Tạo cấu trúc rõ ràng theo `src/features`, `src/components`, `src/lib`, `src/api`, `src/routes` (điều chỉnh theo cấu trúc template nếu template đã có convention tốt hơn).
- Không lưu private token vào `localStorage`, `sessionStorage`, cookie, Zustand persist, URL, React Query cache, analytics, error-reporting payload hoặc bất cứ log nào. Token chỉ tồn tại trong bộ nhớ runtime ngắn hạn của trình duyệt và chỉ được truyền qua HTTPS tới backend khi thực hiện request cần Cloud API.

### Backend

- Python 3.12+ với FastAPI, Pydantic v2, SQLAlchemy 2.x/Alembic (hoặc cơ chế migration tương đương), HTTPX async và SQLite.
- Tổ chức tối thiểu: `app/api`, `app/core`, `app/models`, `app/schemas`, `app/services`, `app/repositories`, `app/gateway`, `app/db`, `tests`.
- Tách rõ router, service, repository và Cloud API gateway. Router không được tự gọi HTTPX hoặc viết SQL trực tiếp.
- Cấu hình typed từ `.env`, có `.env.example`, validate cấu hình khi startup. Bao gồm tối thiểu: `APP_ENV`, `DEBUG`, `DATABASE_URL`, `CORS_ORIGINS`, `TRUSTED_HOSTS`, `PAGE_SIZE_DEFAULT`, `PAGE_SIZE_MAX`, `CLOUD_API_BASE_URL`, `CLOUD_API_ALLOWED_HOSTS`, `CLOUD_CONCURRENCY_LIMIT`, `CLOUD_API_TIMEOUT_SECONDS`, `CLOUD_API_CONNECT_TIMEOUT_SECONDS`, `CLOUD_API_RETRY_COUNT`, `TOKEN_MAX_IDLE_SECONDS`, `DEBUG_CLOUD_APPROVAL_MODE`, `UPLOAD_MAX_BYTES`, `EXPORT_MAX_ROWS`, `LOG_RETENTION_DAYS`, `PASSWORD_PROFILE_ENCRYPTION_KEY`.
- SQLite ở `data/` với foreign key enforcement, migrations, indexes cho các truy vấn log thường dùng và WAL mode nếu phù hợp.
- Thiết kế để tương lai thay SQLite bằng PostgreSQL với thay đổi tối thiểu.
- Backend là nguồn chân lý cho giới hạn page size. Frontend lấy runtime config an toàn từ một endpoint bootstrap thay vì giả định biến Vite build-time luôn đồng bộ với backend.

## 4. Bảo mật bắt buộc

### Xác thực và phân quyền ứng dụng

- Cài đặt đăng nhập, đăng xuất, tạo/sửa/vô hiệu hóa user và RBAC tối thiểu gồm `admin`, `operator`, `viewer`.
- Lưu mật khẩu ứng dụng bằng Argon2 hoặc bcrypt; không bao giờ plaintext. Bootstrap admin qua biến môi trường/command an toàn, không hard-code mật khẩu.
- Session cookie phải `HttpOnly`, `Secure` trong production, `SameSite` phù hợp; có expiration và logout/revocation. Bảo vệ endpoint bằng authentication + authorization rõ ràng.
- Chống session fixation bằng cách rotate session khi login/đổi quyền; bảo vệ các request thay đổi trạng thái bằng CSRF token hoặc cơ chế tương đương tương thích với cookie session. Không dùng `GET` cho mutation.
- `viewer` chỉ đọc/export; `operator` được thao tác cloud theo quyền; `admin` quản trị user, app settings và clear log. Các quyền chi tiết phải được tập trung trong policy/dependency, không kiểm tra rải rác ở UI.

### Private token Cloud API

- Sau khi đăng nhập, bắt buộc người dùng nhập private token trước khi dùng chức năng cloud. Input phải password-masked, có nút xóa token, không hiển thị lại token và không tự điền lại.
- Token không được ghi vào database, file, log, trace, audit payload, request/response debug, cache, queue hoặc crash report. Không dùng token làm khóa định danh.
- Backend chỉ nhận token trong header riêng cho request đang thực thi (ví dụ `X-Cloud-Token`), trích xuất ngay trong boundary request, chuyển trực tiếp cho gateway và xóa/thả tham chiếu sau request. Gateway chỉ thêm nó vào header `Authorization` ngay trước khi gọi Cloud API.
- Mọi sanitizer/middleware/logging phải redact hoàn toàn `Authorization`, `X-Cloud-Token`, `token`, `password`, `secret` trong header, body và exception. Không log request body thô nếu có nguy cơ chứa secret.
- URL console trả về có query/path chứa credential dùng một lần và phải được coi là secret: không lưu/log/audit/export/analytics toàn bộ URL, không đưa vào browser history lâu hơn cần thiết. Backend chỉ trả URL cho request được phép, validate scheme `https` và hostname theo allowlist; frontend mở bằng `noopener,noreferrer`.
- Token mất khi refresh/đóng tab hoặc hết idle timeout; UI phải quay lại màn hình nhập token. Đây là hệ quả bắt buộc của yêu cầu không lưu token ở bất cứ đâu.
- Không có token nào được trả về frontend từ backend.

### An toàn vận hành

- Validate input ở cả frontend và backend; giới hạn page size; CORS allowlist; security headers; rate limit hợp lý cho đăng nhập và endpoint thao tác nguy hiểm; timeout rõ ràng cho HTTP client.
- Dùng correlation/request ID xuyên suốt response, user audit log và Cloud API log.
- Không log PII/secret không cần thiết. Không để exception stack trace lộ ra client trong production.
- Dùng retry có giới hạn và exponential backoff chỉ cho request idempotent/an toàn theo API docs. Không tự retry thao tác thay đổi trạng thái trừ khi có idempotency đảm bảo.
- Chống SSRF: `CLOUD_API_BASE_URL` và mọi URL upstream phải dùng HTTPS trong production và hostname allowlist; không tin hoặc follow mù trường `next` do upstream trả về. Pagination phải parse page/query được phép rồi dựng request từ base URL tin cậy.
- Upload CSV/XLSX phải giới hạn dung lượng, số dòng/cột, loại file bằng nội dung thực, thời gian parse và kích thước giải nén; từ chối macro, external link, công thức và file zip-bomb. File tạm có tên ngẫu nhiên, nằm ngoài web root, quyền truy cập tối thiểu và luôn được xóa sau xử lý. Khi export CSV/XLSX, neutralize giá trị bắt đầu bằng `=`, `+`, `-`, `@` để chống formula injection.

## 5. Cloud API gateway, debug và logging

- Cài một `CloudApiGateway`/client dùng chung có: base URL cấu hình, timeout connect/read/write/pool, chuẩn hóa lỗi, correlation ID, retry policy, redaction và mapping response.
- Mọi request Cloud API phải gửi `project-id` header theo đúng tên header trong API docs và project hiện được chọn. Không lấy project từ tên.
- Tạo Cloud API log ngay trước khi gửi request, trạng thái `started`; khi nhận được response hoặc lỗi, cập nhật cùng bản ghi với status, latency, HTTP status, endpoint/method đã redact, mã lỗi và response metadata/body đã sanitize. Vì vậy request lỗi/timeout vẫn có log đầy đủ.
- Không lưu response body không giới hạn: áp dụng allowlist field hoặc giới hạn kích thước/truncate có đánh dấu. Redact đệ quy không phân biệt hoa thường ở object, list, query string và chuỗi URL; có test cho secret lồng nhau và console URL.
- Audit log người dùng phải ghi actor, role, action, target type/ID, project ID, timestamp, correlation ID, kết quả và metadata đã sanitize. Không ghi token/password.
- Màn hình Audit Log có hai tab: `User activity` và `Cloud API history`; cả hai đều server-side pagination, filter, sort và clear log theo quyền admin. Clear log yêu cầu confirmation modal và chính sách audit rõ ràng (nếu xóa log là yêu cầu nghiệp vụ, ghi một audit event tối thiểu không chứa nội dung log đã xóa).
- `DEBUG_CLOUD_APPROVAL_MODE=false` mặc định. Khi bật ở môi trường được phép, trước mỗi Cloud API request (cả read và mutation, đúng yêu cầu debug gốc) backend trả một preview đã redact; frontend mở modal cho người dùng xem method, endpoint, project ID và payload đã redact rồi xác nhận. Preview tạo approval ID/nonce dùng một lần, TTL ngắn, ràng buộc với user/session/project/action và hash của request đã chuẩn hóa; bước execute phải tự dựng lại đúng request từ dữ liệu server-side, kiểm tra hash/nonce và yêu cầu frontend gửi lại private token. Không lưu token trong pending approval và không cho client sửa method/path/body giữa preview và execute. Không hỗ trợ chế độ này trong production.
- HTTP `202 Accepted` chỉ có nghĩa upstream đã nhận yêu cầu, không được hiển thị là hoàn tất. Với `Change Password server` và `Share Network to project`, trả trạng thái `accepted/pending`; chỉ chuyển `completed` nếu có endpoint kiểm tra trạng thái được tài liệu hóa. Nếu docs không có endpoint đó, UI nói rõ “đã được tiếp nhận, chưa xác minh hoàn tất” và không tự bịa polling API.

### Khả năng thích ứng khi Cloud API thay đổi

- Thiết kế integration theo anti-corruption layer/ports-and-adapters. Business service chỉ gọi interface nghiệp vụ ổn định (ví dụ `ProjectProvider`, `ServerProvider`, `NetworkProvider`, `ShareProvider`) và dùng DTO/domain model nội bộ; không được phụ thuộc trực tiếp vào URL, HTTP method, request/response schema hoặc field nguyên bản của Cloud API.
- Mỗi endpoint/version Cloud API có adapter riêng để build request, inject headers, parse/validate response và map sang DTO nội bộ. Tập trung endpoint path, method, header name, API version, feature flag và mapping config vào module có version rõ ràng; không rải endpoint string/schema Cloud API vào router, service, repository hay frontend.
- Khi Cloud API thay đổi, chỉ thêm/sửa adapter và mapping tương ứng rồi chọn implementation qua dependency injection/configuration; không thay đổi luồng nghiệp vụ chính. Hỗ trợ coexistence adapter version (ví dụ `CloudApiV1Adapter`, `CloudApiV2Adapter`) qua environment/config hoặc feature flag theo endpoint, tránh big-bang migration.
- Chuẩn hóa lỗi Cloud API thành error model nội bộ ổn định: authentication, authorization, validation, not-found, conflict, rate-limit, timeout, upstream-unavailable và unexpected-upstream. Business logic/UI chỉ xử lý model này, còn upstream status/code đã redact chỉ được dùng cho Cloud API log chẩn đoán.
- Viết contract/fixture tests cho từng adapter theo ví dụ chính thức trong `APIdoc`, bao gồm response cũ, thiếu field và field mới không mong đợi. Có smoke/integration test bật bằng env cho Cloud API test. README phải hướng dẫn cách thêm hoặc nâng cấp adapter mà không tác động service/frontend.
## 6. Luồng ứng dụng và chọn ngữ cảnh

1. Người dùng đăng nhập.
2. Nếu chưa có private token trong memory, hiển thị token gate và chặn toàn bộ route cloud.
3. Dùng token vừa nhập để lấy phạm vi project theo API docs: cho chọn organization hoặc personal scope, sau đó load list project và chọn đúng một project.
4. Project hiện tại được giữ ở state runtime có chủ đích, hiển thị rõ trong app shell. Mọi request cloud bắt buộc có project ID hiện tại.
5. Người dùng có thể đổi scope/project. Sau khi xác nhận, hủy request đang chạy nếu có thể, xóa toàn bộ state/cache/query/batch draft phụ thuộc project, điều hướng về route an toàn và hard reload toàn bộ ứng dụng như yêu cầu. Vì token tuyệt đối không được persist, hard reload đồng nghĩa token bị mất: phải cảnh báo trước và đưa người dùng về token gate để nhập lại. Không được lách mâu thuẫn này bằng cách lưu token vào browser storage.
6. Nếu token lỗi/hết hạn, hiển thị thông báo hữu ích, xóa token runtime và quay về token gate.

Các endpoint lấy organization/project là luồng bootstrap xảy ra trước khi có project được chọn. Không gửi UUID giả hoặc project mặc định. Hãy xác minh trong API docs/thử nghiệm được phép xem các endpoint này có thực sự cần `project-id` hay không; nếu tài liệu chưa đủ để quyết định, cô lập quy tắc trong bootstrap adapter, ghi blocker rõ ràng và không làm suy yếu yêu cầu `project-id` cho mọi API sau khi đã chọn project.

Mọi cache key và request phải chứa project ID hiện tại; không dùng cache Cloud API dùng chung giữa người dùng/token. Response đến muộn từ project cũ phải bị bỏ qua sau project switch.

## 7. Chức năng chi tiết

### 7.1 Quản lý tài khoản server

- Cung cấp CRUD cho nhiều profile user/password mặc định dùng khi đổi password server.
- Password profile phải được mã hóa at-rest bằng khóa cấu hình qua environment hoặc secret provider; không trả plaintext sau khi tạo. Thiết kế schema và service để chỉ giải mã ngay lúc cần gọi Cloud API.
- Nếu chưa có hạ tầng khóa phù hợp, không giả vờ bảo mật bằng base64: vô hiệu hóa lưu profile password và nêu rõ cấu hình bắt buộc trong README. Không lưu plaintext.
- Có name/label, username, trạng thái và audit trail; mọi sửa/xóa/áp dụng profile phải confirmation phù hợp.
- API docs hiện chỉ mô tả payload `new_password`, không có username. Vì vậy `username` chỉ là metadata/nhãn để người dùng quản lý profile, tuyệt đối không tuyên bố đã đổi password cho một OS user cụ thể nếu upstream không hỗ trợ trường đó. Ghi giới hạn này trong UI/README.
- Password policy phải dùng chung một validator backend làm nguồn chân lý và schema chia sẻ/đồng bộ cho frontend. Tài liệu ghi “> 8 ký tự, có chữ hoa, chữ, số, ký tự đặc biệt” nhưng ví dụ `abcd@123` không thỏa điều kiện; ưu tiên rule bằng lời, thêm test boundary và ghi rõ mâu thuẫn tài liệu.

### 7.2 Quản lý server

- Lấy toàn bộ server của project bằng endpoint `Get List Server of project` trong docs. Lấy zone bằng `Get List Zone`, join theo zone ID và hiển thị `display_name`.
- Datatable hiển thị ít nhất: `id`, `name`, `elastic_ip`, `private_ip`, `server_type`, `zone`, `bandwidth`. Hai cột IP hiển thị danh sách `ip_address` gọn; trong row-detail hiển thị raw data đã được phép.
- Có server-side search/sort/filter/pagination, chọn một/nhiều server, row detail modal, tooltip cho cell bị truncate, export CSV/XLSX.
- Bulk change password: người dùng chọn server và profile, xem danh sách server/profile thay đổi trong confirmation modal, rồi gọi `Change Password server` theo đúng docs. Hiển thị kết quả theo từng `server_id`, không fail toàn bộ batch chỉ vì một item thất bại nếu API cho phép tiếp tục.
- Bulk rename: tải XLSX template đã có các server được chọn và cột `server_id`, `current_name`, `new_name`. Upload phải validate header, ID thuộc selection/current project, new name không rỗng và duplicate theo rule API. Preview diff trước confirm, sau đó gọi `change name of server` bằng `server_id`. Trả về bảng kết quả từng dòng và file lỗi nếu cần.
- Mỗi server có action `Open console` theo endpoint trong docs. Chỉ mở URL/console được backend validate; tránh open redirect.
- Export toàn bộ server của project ở CSV/XLSX với hai chế độ: `full` (đầy đủ trường Cloud API an toàn để export) và `simple`. `simple` có: `id`, `name`, `elastic_ip`, `private_ip`, `server_type`, `zone`, `bandwidth`; mỗi object IP thành một cột với `id` và `ip_address` theo cấu trúc ổn định được ghi trong UI/template.
- “Export toàn bộ” phải duyệt tất cả trang upstream một cách có giới hạn và stream kết quả, không chỉ export page đang xem. File phải có tên an toàn, timestamp/timezone rõ ràng và metadata project ID; không đưa secret, console URL, key pair public key hoặc field nhạy cảm ngoài allowlist vào chế độ `full`.
- Change password trả `202`; kết quả từng item phải dùng trạng thái `accepted/pending`, không gắn nhãn success hoàn tất nếu chưa có cách xác minh theo docs.

### 7.3 Tạo private IP theo dải

- Bắt buộc chọn subnet. Dùng endpoint `get Subnet` và `get private IP with subnet IP` để hiển thị subnet và IP hiện có.
- Hỗ trợ hai phương thức input có validate IPv4/IPv6 và CIDR/range phù hợp docs: nhập start-end IP, hoặc start IP + số lượng. Kiểm tra dải hợp lệ, không vượt subnet, không vượt giới hạn batch, không trùng IP hiện có hoặc IP lặp trong request.
- Tạo IP bằng `create ip_address`. Theo yêu cầu nghiệp vụ, IP chỉ được coi là thành công khi response có `description == ""` và `server == null`; ghi rõ distinction `API response success` và `business success` trong kết quả.
- Hiển thị bảng thành công/thất bại, IP, `ip_id`, request/result/error đã sanitize. Lưu dấu đánh dấu backend theo `ip_id`, timestamp, actor, project ID và batch/correlation ID.
- Tùy chọn tạo bù: khi bật, chỉ tạo bù các IP business-failed bằng các IP tuần tự sau cuối dải, với giới hạn batch và preview đầy đủ. Phải confirmation trước mutation và kết thúc hữu hạn khi đạt số lượng yêu cầu/hết subnet/đạt retry limit.
- Loại trừ network address, broadcast address với IPv4 và các địa chỉ reserved/gateway nếu subnet/API docs xác định; không tự giả định quy tắc IPv6. Thuật toán tạo bù phải chống overflow, không vượt CIDR và không lặp lại IP đã thử trong cùng batch.
- Sau khi hoàn tất, reload danh sách IP vừa xử lý (bao gồm thành công và thất bại), có filter theo batch và export CSV/XLSX.

### 7.4 Attach IP hàng loạt vào server

- Hiển thị server hiện tại, cho chọn một/nhiều server. Nhập nguồn IP từ batch đã tạo trước đây hoặc upload XLSX template.
- Template phải có `server_id`, `server_name`, `existing_ip`, `new_ip` và các cột định danh cần thiết để validate. `server_name` chỉ để người dùng đối chiếu, mapping bắt buộc bằng `server_id`; IP mapping phải dùng `ip_id`/định danh có trong docs, không dựa duy nhất vào chuỗi display nếu API yêu cầu ID.
- Hỗ trợ auto-match theo thứ tự có thể dự đoán và custom mapping qua template. Validate số lượng, server/IP duplicate, project ownership, IP có sẵn, server status nếu docs quy định.
- Trước khi gọi API, kiểm tra zone của server, subnet và IP. Nếu không khớp hoặc không xác minh được, chặn thao tác và chỉ rõ từng item lỗi.
- Theo docs hiện tại subnet/private IP cung cấp `region`, còn server cung cấp `zone` UUID và zone API map sang region. Chuẩn hóa so khớp qua `server.zone -> Zone.region.name` với `subnet.region`/`private_ip.region`; không so sánh trực tiếp UUID zone với chuỗi region.
- Hiển thị datatable preview mapping và full confirmation modal. Sau xác nhận, gọi `attach ip_address to server`, trả kết quả từng dòng và lưu marker backend theo `server_id`, timestamp, actor, project ID/correlation ID. Có export kết quả.

### 7.5 Share monitor project

- Cho phép share VPC monitor tới project đang chọn bằng endpoint `Share Network to project`.
- Hiển thị/validate VPC, `project_id` và zone. Kiểm tra zone một lần nữa ngay trước mutation; nếu mismatch phải chặn và nêu lỗi.
- Cho phép thêm nhiều VPC/project mapping trong UI, validate từng mapping, preview và xác nhận trước khi thực thi. Không suy đoán cách lấy VPC/zone nếu docs không mô tả; dùng adapter/TODO rõ ràng.
- Các UUID VPC/project theo region trong tài liệu phải được xem là mapping cấu hình có validate, không rải thành magic constant. Tách rõ: project đang được chọn là target trong body `projects`; project monitor của region là giá trị header `project-id`; VPC monitor của region nằm trong path. Revalidate cả ba ngay trước khi gọi.
- API share trả `202`; hiển thị `accepted/pending` và giới hạn như mục logging/gateway, không báo “share thành công hoàn tất” khi chưa xác minh được.

### 7.6 Settings

- Có trang Settings cho các setting ứng dụng hợp lý: page size mặc định của người dùng (bounded bởi server max), timezone/UI preference nếu cần, quản lý user (admin), session/security visibility, retention/clear audit log theo quyền.
- Secret, Cloud API base URL, encryption key và debug mode là server configuration từ environment, không được chỉnh sửa qua UI trừ khi có cơ chế quản lý secret an toàn đã được triển khai.

## 8. Tiêu chuẩn UI/UX thống nhất

- Bám sát ngôn ngữ thiết kế của `TemplateWeb`, không thay bằng giao diện boilerplate khác. Dùng tiếng Việt rõ ràng cho UI, với API/error code kỹ thuật ở vùng chi tiết.
- Tất cả list table đều chuẩn hóa thành reusable datatable: server-side pagination, page-size selector (mặc định từ env, người dùng được chọn trong giới hạn), sort, search, filter khi phù hợp, row selection, CSV/XLSX export, loading/empty/error state.
- Click row mở modal/detail drawer chứa toàn bộ thông tin an toàn của row. Nội dung cell dài có truncate + tooltip.
- Mọi modal có header cố định/sticky, title rõ, close action, body scroll độc lập và footer action nhất quán. Focus management và keyboard escape phải hoạt động.
- Mutation quan trọng, nguy hiểm hoặc batch luôn có confirmation modal nêu rõ số lượng, target IDs, thay đổi trước/sau, cảnh báo không thể hoàn tác, project đang tác động và nút hành động phân biệt rõ. Disabled/loading state phải ngăn double-submit.
- Confirmation phải hiển thị timestamp của preview và phát hiện dữ liệu đã stale. Backend revalidate selection/resource state; nếu dữ liệu thay đổi kể từ preview, hủy confirmation cũ và yêu cầu preview lại.
- Bố cục phải dùng tốt không gian desktop và vẫn dùng được trên mobile/tablet; các table rộng có chiến lược responsive rõ ràng (horizontal scroll hoặc cột ưu tiên).

## 9. API nội bộ và dữ liệu

- Thiết kế REST API nội bộ có version prefix (ví dụ `/api/v1`), schema request/response Pydantic, status code đúng, error envelope nhất quán và OpenAPI docs tắt/giới hạn phù hợp production.
- Pagination server-side có `page`, `page_size`, tổng số, giới hạn giá trị rõ ràng. Không tải toàn bộ audit log vào trình duyệt.
- Cung cấp endpoint export streaming khi dữ liệu lớn; validate quyền/project scope trước export.
- Tạo schema/migration cho users, sessions/revocation nếu cần, audit logs, cloud API logs, batch execution/markers, password profiles metadata/ciphertext và app/user settings. Bao gồm indexes theo các filter phổ biến (`created_at`, `user_id`, `project_id`, `correlation_id`, `action`, `status`).
- Dữ liệu log, marker, batch và profile phải scoped rõ theo project/user khi cần; không làm rò rỉ dữ liệu giữa user/project.
- Mutation nội bộ nhận idempotency key/request key cho double-click/network retry và có unique constraint phù hợp. Cùng key + cùng payload trả lại execution hiện có; cùng key + payload khác phải bị từ chối. Không suy diễn rằng idempotency nội bộ khiến một mutation upstream trở nên an toàn để tự retry.
- Batch execution có state machine rõ ràng (`draft`, `validated`, `confirmed`, `running`, `accepted`, `partially_failed`, `completed`, `failed`, `cancelled` khi hỗ trợ), thống kê item và timestamps. Restart ứng dụng không được biến batch đang chạy thành “success”; reconcile sang trạng thái `interrupted/unknown` nếu không thể biết kết quả upstream.
- Không đưa private token vào database, task queue hoặc payload job để chạy unattended. Batch dài phải được chia thành chunk hữu hạn: database chỉ lưu execution plan/hash/trạng thái đã sanitize, còn frontend gửi lại token đang giữ trong memory cho mỗi request thực thi chunk. Mỗi chunk revalidate user/session/project/approval và có idempotency key; mất token/reload thì batch tạm dừng an toàn và người dùng nhập lại token để tiếp tục các item chưa chạy, không tự retry item có kết quả `unknown`.

## 10. Chất lượng, kiểm thử và tài liệu bàn giao

- Không tạo mock để che giấu integration thiếu. Có thể tạo fake Cloud gateway rõ ràng chỉ cho test/development, tách khỏi production gateway.
- Viết unit tests cho authorization, token redaction, Cloud gateway error/timeout behavior, service validation (range IP, zone matching, bulk import), và repository pagination.
- Viết integration tests cho login/RBAC, audit logging, cloud request lifecycle `started -> completed/failed`, export permissions và các API nội bộ trọng yếu. Frontend cần test các luồng token gate, project switch, confirmation modal và validation upload quan trọng.
- Thêm test cho CSRF/session fixation, approval nonce replay/expiry/payload tampering, project isolation/cache race, SSRF/redirect, malicious XLSX/CSV formula, pagination nhiều trang, `202 accepted`, idempotency, batch partial failure/resume và chứng minh token không xuất hiện trong batch state/job payload.
- Chạy formatter, linter, type-check, test và production build của frontend; chạy backend test/migration check. Sửa mọi lỗi do thay đổi gây ra.
- Chạy secret scan trên source/test fixture/build artifact, kiểm tra dependency vulnerability phù hợp hệ sinh thái và bảo đảm fixture không chứa token/credential thật. Không được làm test pass bằng cách tắt security check.
- Viết `README.md` gốc hoặc cập nhật README hiện có: kiến trúc, prerequisites, cách tạo `.env`, migration/seed admin, development, production deployment, backup SQLite, cách test, mapping Cloud API docs, threat model ngắn và các giới hạn/TODO do API docs thiếu.
- Cung cấp `.env.example` không có secret, `.gitignore` chặn `.env`, database runtime, export temporary, logs và file upload runtime.

## 11. Vận hành production

- Cung cấp Dockerfile/build nhiều stage và ví dụ triển khai sau reverse proxy HTTPS, hoặc tài liệu triển khai tương đương nếu convention repo yêu cầu cách khác. Không chạy development server trong production.
- Có endpoint liveness và readiness không lộ secret; readiness kiểm tra database/migration và cấu hình thiết yếu nhưng không gọi mutation Cloud API. Có graceful shutdown, đóng HTTP client/DB connection và không nhận batch mới khi đang drain.
- Log ứng dụng có cấu trúc, correlation ID và level hợp lý; metrics tối thiểu cho request latency/error, Cloud API latency/status, batch count/failure và SQLite contention. Không gắn token, password, raw body hoặc console URL làm label/log.
- Với SQLite, tài liệu hóa giới hạn concurrency, backup/restore đã kiểm thử, retention/cleanup log theo batch nhỏ và chiến lược migration. Mặc định production chạy số worker tương thích SQLite; nếu cần scale ngang hoặc nhiều worker ghi đồng thời, yêu cầu chuyển PostgreSQL trước.
- Tất cả timestamp lưu UTC và trả ISO 8601 có timezone; UI hiển thị theo timezone người dùng/cấu hình. Retention job và export phải nhất quán timezone.
- Thiết lập Content Security Policy, HSTS ở HTTPS production, `X-Content-Type-Options`, `Referrer-Policy`, frame protection phù hợp và không để source map chứa thông tin nhạy cảm được public ngoài ý muốn.

## 12. Tiêu chí hoàn thành

Chỉ coi là hoàn thành khi:

1. Frontend nằm trong `frontend/`, backend trong `backend/`, SQLite runtime/data trong `data/` đúng yêu cầu.
2. Không có private token, Authorization hay password plaintext trong database, file, browser persistence, console/log/audit/API log hoặc response.
3. Cloud API chỉ được gọi qua gateway backend, sử dụng project ID hiện tại trong header theo docs, có timeout, error mapping, log lifecycle và redaction.
4. Login/RBAC, token gate, chọn/đổi project, server management, IP range creation, bulk attach, audit logs, project sharing và settings đều có luồng UI/backend tương ứng hoặc một TODO tích hợp chính xác do API docs không cung cấp.
5. Tất cả mutation/batch có preview/confirmation và kết quả theo từng item; zone validation được thực hiện cho attach/share.
6. UI thống nhất với template, responsive, table/modal được chuẩn hóa và có pagination/export.
7. Linter, type-check, tests và production build đã chạy thành công; báo cáo rõ các lệnh đã chạy và mọi hạn chế còn lại.
8. Không có lỗ hổng hiển nhiên qua CSRF, SSRF/open redirect, approval replay/tampering, spreadsheet injection hoặc upload resource exhaustion; các kiểm soát chính có test.
9. Các response `202` được biểu diễn đúng là accepted/pending, batch có giới hạn concurrency/idempotency nội bộ và không báo sai trạng thái sau restart.
10. Có hướng dẫn production, health/readiness, backup/restore SQLite, log retention, observability và secret scan.

## 13. Cách thực hiện và báo cáo

Hãy thực hiện theo thứ tự: khảo sát repository + API docs, lập inventory/decision log và nêu plan ngắn; cài nền tảng/migrations/auth; gateway + logging + approval flow; batch framework; các feature theo dependency; frontend; tests; hardening; rồi verification. Khi cần đưa ra quyết định do đặc tả thiếu, chọn phương án an toàn nhất, ghi rõ giả định trong README và không tạo endpoint Cloud API giả.

Không dừng ở việc scaffold hoặc để placeholder cho phần có đủ contract trong `APIdoc`. TODO chỉ được chấp nhận khi nêu: thông tin còn thiếu, ảnh hưởng, hành vi fail-closed hiện tại và dữ liệu/tài liệu cần bổ sung để hoàn tất.

Kết thúc bằng báo cáo ngắn gồm: file chính đã thêm/sửa, kiến trúc đã triển khai, test/build/security check đã chạy, biến môi trường cần thiết, migration/backup note, và các integration blocker cụ thể (nếu có). Báo cáo không được chứa secret hoặc URL console đầy đủ.
