// scripts/seed-translations-master.js — Master translation seed (all UI strings)
// Run: node scripts/seed-translations-master.js
const db = require('../db');

db.prepare(`CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, en TEXT, ar TEXT, section TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

const seed = [
  [
    "% Utilization",
    "% الاستخدام"
  ],
  [
    "A-Frame Slots",
    "فتحات الحامل"
  ],
  [
    "A-Frames",
    "الحوامل"
  ],
  [
    "ACTIONS",
    "الإجراءات"
  ],
  [
    "AGI GLASS",
    "AGI GLASS"
  ],
  [
    "Absences",
    "الغياب"
  ],
  [
    "Access",
    "الصلاحيات"
  ],
  [
    "Account Status",
    "حالة الحساب"
  ],
  [
    "Accrual/month",
    "استحقاق/شهر"
  ],
  [
    "Actions",
    "الإجراءات"
  ],
  [
    "Activate All",
    "تفعيل الكل"
  ],
  [
    "Active",
    "نشط"
  ],
  [
    "Active only",
    "النشطون فقط"
  ],
  [
    "Add",
    "إضافة"
  ],
  [
    "Add Document",
    "إضافة وثيقة"
  ],
  [
    "Add Entry",
    "إضافة قيد"
  ],
  [
    "Add piece by UID (Enter to add)...",
    "إضافة قطعة بالمعرّف (Enter للإضافة)..."
  ],
  [
    "Added by",
    "أضيف بواسطة"
  ],
  [
    "Additional info...",
    "معلومات إضافية..."
  ],
  [
    "Address",
    "العنوان"
  ],
  [
    "Adjustment",
    "تعديل"
  ],
  [
    "Adjustments",
    "التعديلات"
  ],
  [
    "Admin",
    "مدير"
  ],
  [
    "Admin Notes (optional)",
    "ملاحظات المدير (اختياري)"
  ],
  [
    "All",
    "الكل"
  ],
  [
    "All Categories",
    "كل الفئات"
  ],
  [
    "All Colors",
    "كل الألوان"
  ],
  [
    "All Customers",
    "كل العملاء"
  ],
  [
    "All Done",
    "الكل منجز"
  ],
  [
    "All Files",
    "كل الملفات"
  ],
  [
    "All Orders",
    "كل الطلبات"
  ],
  [
    "All Sheets",
    "كل الألواح"
  ],
  [
    "All Slots",
    "كل الفتحات"
  ],
  [
    "All Status",
    "كل الحالات"
  ],
  [
    "All Suppliers",
    "كل الموردين"
  ],
  [
    "All Thickness",
    "كل السماكات"
  ],
  [
    "All Thicknesses",
    "كل السماكات"
  ],
  [
    "All Types",
    "كل الأنواع"
  ],
  [
    "All Workers",
    "كل العمال"
  ],
  [
    "Amount",
    "المبلغ"
  ],
  [
    "Amount (JOD, can be negative)",
    "المبلغ (دينار، قد يكون سالب)"
  ],
  [
    "Annual Vacation Days",
    "أيام الإجازة السنوية"
  ],
  [
    "Antique",
    "عتيق"
  ],
  [
    "Any additional details...",
    "أي تفاصيل إضافية..."
  ],
  [
    "Apply",
    "تطبيق"
  ],
  [
    "Apply to All",
    "تطبيق على الكل"
  ],
  [
    "Approve",
    "موافقة"
  ],
  [
    "Approve Device",
    "الموافقة على الجهاز"
  ],
  [
    "Approved",
    "موافق عليه"
  ],
  [
    "Arabic",
    "عربي"
  ],
  [
    "Assign",
    "تعيين"
  ],
  [
    "Assign Optimization Cuts to Slots",
    "تعيين قصاصات التحسين للفتحات"
  ],
  [
    "Assign Stock",
    "تعيين المخزون"
  ],
  [
    "Assigned to Slots",
    "معيّن لفتحات"
  ],
  [
    "Assignments & Transfers",
    "التعيينات والتحويلات"
  ],
  [
    "Attendance",
    "الحضور"
  ],
  [
    "Available",
    "متاح"
  ],
  [
    "Available glass offcuts",
    "قطع الزجاج المتبقية"
  ],
  [
    "BALANCE",
    "الرصيد"
  ],
  [
    "Back",
    "رجوع"
  ],
  [
    "Back to Workers",
    "الرجوع للعمال"
  ],
  [
    "Backup & Restore",
    "نسخ احتياطي واستعادة"
  ],
  [
    "Balance",
    "الرصيد"
  ],
  [
    "Balance Deduct",
    "خصم الرصيد"
  ],
  [
    "Balanced",
    "متوازن"
  ],
  [
    "Base",
    "الأساس"
  ],
  [
    "Black",
    "أسود"
  ],
  [
    "Blue",
    "أزرق"
  ],
  [
    "Brand (شركة)",
    "الماركة (شركة)"
  ],
  [
    "Brand / Company",
    "الماركة / الشركة"
  ],
  [
    "Break (mins)",
    "الاستراحة (دقائق)"
  ],
  [
    "Bronze",
    "برونزي"
  ],
  [
    "Buyer",
    "المشتري"
  ],
  [
    "Buyer name...",
    "اسم المشتري..."
  ],
  [
    "By",
    "بواسطة"
  ],
  [
    "By Process",
    "حسب العملية"
  ],
  [
    "CODE",
    "الرمز"
  ],
  [
    "CREATED BY",
    "أنشأ بواسطة"
  ],
  [
    "CSV",
    "CSV"
  ],
  [
    "CUSTOMER",
    "العميل"
  ],
  [
    "CUT SIZE",
    "قياس القص"
  ],
  [
    "Calculate",
    "احتساب"
  ],
  [
    "Cancel",
    "إلغاء"
  ],
  [
    "Cancel Order",
    "إلغاء الطلب"
  ],
  [
    "Cancel Reason *",
    "سبب الإلغاء *"
  ],
  [
    "Cancel Reasons",
    "أسباب الإلغاء"
  ],
  [
    "Cancel order",
    "إلغاء الطلب"
  ],
  [
    "Cancelled",
    "ملغي"
  ],
  [
    "Category",
    "الفئة"
  ],
  [
    "Category (زجاج/مرايا)",
    "الفئة (زجاج/مرايا)"
  ],
  [
    "Certificate",
    "شهادة"
  ],
  [
    "Change Password",
    "تغيير كلمة السر"
  ],
  [
    "Change Photo",
    "تغيير الصورة"
  ],
  [
    "Classification",
    "التصنيف"
  ],
  [
    "Clear",
    "مسح"
  ],
  [
    "Clear All",
    "مسح الكل"
  ],
  [
    "Clear all filters",
    "مسح كل المرشحات"
  ],
  [
    "Client Database",
    "قاعدة بيانات العملاء"
  ],
  [
    "Close",
    "إغلاق"
  ],
  [
    "Close Month",
    "إغلاق الشهر"
  ],
  [
    "Code",
    "الرمز"
  ],
  [
    "Color",
    "اللون"
  ],
  [
    "Color (اللون)",
    "اللون"
  ],
  [
    "Company",
    "الشركة"
  ],
  [
    "Company (optional)",
    "الشركة (اختياري)"
  ],
  [
    "Company / Supplier",
    "الشركة / المورد"
  ],
  [
    "Completed",
    "منجز"
  ],
  [
    "Completed / Cancelled",
    "منجز / ملغي"
  ],
  [
    "Confirm",
    "تأكيد"
  ],
  [
    "Correction",
    "تصحيح"
  ],
  [
    "Current Data Summary",
    "ملخص البيانات الحالية"
  ],
  [
    "Current Stock Levels",
    "مستويات المخزون الحالية"
  ],
  [
    "Customer",
    "العميل"
  ],
  [
    "Customer *",
    "العميل *"
  ],
  [
    "Customer List",
    "قائمة العملاء"
  ],
  [
    "Customer PO / site ref...",
    "أمر شراء العميل / المرجع..."
  ],
  [
    "Customer delivery notes and history",
    "تاريخ وإشعارات تسليم العملاء"
  ],
  [
    "Customers",
    "العملاء"
  ],
  [
    "Cut Size",
    "قياس القص"
  ],
  [
    "Cutting",
    "القص"
  ],
  [
    "Cutting Optimization",
    "تحسين القص"
  ],
  [
    "Cutting Queue",
    "قائمة القص"
  ],
  [
    "DATE",
    "التاريخ"
  ],
  [
    "DELIVERY CODE",
    "رمز التسليم"
  ],
  [
    "Dashboard",
    "لوحة التحكم"
  ],
  [
    "Date",
    "التاريخ"
  ],
  [
    "Date Added &#8597;",
    "تاريخ الإضافة ↕"
  ],
  [
    "Date Received",
    "تاريخ الاستلام"
  ],
  [
    "Date Used",
    "تاريخ الاستخدام"
  ],
  [
    "Date Used *",
    "تاريخ الاستخدام *"
  ],
  [
    "Date of Birth",
    "تاريخ الميلاد"
  ],
  [
    "Day Type",
    "نوع اليوم"
  ],
  [
    "Days",
    "الأيام"
  ],
  [
    "Days/Hours",
    "أيام/ساعات"
  ],
  [
    "Deactivate All",
    "إلغاء تفعيل الكل"
  ],
  [
    "Del",
    "حذف"
  ],
  [
    "Delete",
    "حذف"
  ],
  [
    "Delivered",
    "تم التسليم"
  ],
  [
    "Deliveries",
    "التوصيلات"
  ],
  [
    "Delivery",
    "التسليم"
  ],
  [
    "Describe the issue...",
    "صف المشكلة..."
  ],
  [
    "Description",
    "الوصف"
  ],
  [
    "Description / Code",
    "الوصف / الرمز"
  ],
  [
    "Discard",
    "تجاهل"
  ],
  [
    "Discarded",
    "مُهمل"
  ],
  [
    "Document Name / Number",
    "اسم/رقم الوثيقة"
  ],
  [
    "Document Type",
    "نوع الوثيقة"
  ],
  [
    "Documents",
    "الوثائق"
  ],
  [
    "Done",
    "منجز"
  ],
  [
    "Download Excel template",
    "تنزيل قالب Excel"
  ],
  [
    "Drilling",
    "تخريم"
  ],
  [
    "EN",
    "إنجليزي"
  ],
  [
    "Edge",
    "الحرف"
  ],
  [
    "Edge (كسر حرف)",
    "الحرف"
  ],
  [
    "Edge Compensation",
    "تعويض الحواف"
  ],
  [
    "Edge Trim (mm)",
    "قص الحواف (مم)"
  ],
  [
    "Edging",
    "تلبيس الحواف"
  ],
  [
    "Edit",
    "تعديل"
  ],
  [
    "Edit Balance",
    "تعديل الرصيد"
  ],
  [
    "Edit order",
    "تعديل الطلب"
  ],
  [
    "Efficiency",
    "الكفاءة"
  ],
  [
    "Email",
    "البريد الإلكتروني"
  ],
  [
    "Email *",
    "البريد الإلكتروني *"
  ],
  [
    "Employment",
    "التوظيف"
  ],
  [
    "Employment Contract",
    "عقد العمل"
  ],
  [
    "Employment Type",
    "نوع التوظيف"
  ],
  [
    "End Time",
    "وقت النهاية"
  ],
  [
    "English",
    "إنجليزي"
  ],
  [
    "Entitlement",
    "الاستحقاق"
  ],
  [
    "Excel",
    "Excel"
  ],
  [
    "Export",
    "تصدير"
  ],
  [
    "Export CSV",
    "تصدير CSV"
  ],
  [
    "Export Log",
    "تصدير السجل"
  ],
  [
    "Export Pivot",
    "تصدير المحور"
  ],
  [
    "Ext Ref",
    "مرجع خارجي"
  ],
  [
    "External Reference",
    "المرجع الخارجي"
  ],
  [
    "FACTORY MANAGEMENT SYSTEM",
    "نظام إدارة المصنع"
  ],
  [
    "FP Field Values",
    "قيم حقول المنتج النهائي"
  ],
  [
    "Factory Config",
    "إعدادات المصنع"
  ],
  [
    "Factory Name",
    "اسم المصنع"
  ],
  [
    "Factory Overview",
    "نظرة عامة على المصنع"
  ],
  [
    "Factory productivity",
    "إنتاجية المصنع"
  ],
  [
    "Filter...",
    "تصفية..."
  ],
  [
    "Final Product",
    "المنتج النهائي"
  ],
  [
    "Final Product Field Values",
    "قيم حقول المنتج النهائي"
  ],
  [
    "Final Products",
    "المنتجات النهائية"
  ],
  [
    "Finalise",
    "إنهاء"
  ],
  [
    "Finalise Delivery",
    "إنهاء التسليم"
  ],
  [
    "Finalised",
    "منتهي"
  ],
  [
    "Friday",
    "الجمعة"
  ],
  [
    "From",
    "من"
  ],
  [
    "Full Day(s)",
    "يوم (أيام) كاملة"
  ],
  [
    "Full Name *",
    "الاسم الكامل *"
  ],
  [
    "Full View",
    "عرض كامل"
  ],
  [
    "Full name",
    "الاسم الكامل"
  ],
  [
    "GLASS",
    "الزجاج"
  ],
  [
    "Glass",
    "زجاج"
  ],
  [
    "Glass Fabrication Orders",
    "طلبات تصنيع الزجاج"
  ],
  [
    "Glass Families",
    "عائلات الزجاج"
  ],
  [
    "Glass Family * — ALL pieces in this order must match",
    "عائلة الزجاج * — كل قطع هذا الطلب يجب أن تتطابق"
  ],
  [
    "Glass Type",
    "نوع الزجاج"
  ],
  [
    "Glass Type (النوع)",
    "نوع الزجاج"
  ],
  [
    "Green",
    "أخضر"
  ],
  [
    "Grey",
    "رمادي"
  ],
  [
    "Gross",
    "الإجمالي"
  ],
  [
    "Height (mm)",
    "الطول (مم)"
  ],
  [
    "Height add (mm)",
    "إضافة الطول (مم)"
  ],
  [
    "Height mm",
    "الطول مم"
  ],
  [
    "Hidden only",
    "المخفي فقط"
  ],
  [
    "Hire Date",
    "تاريخ التوظيف"
  ],
  [
    "History",
    "التاريخ"
  ],
  [
    "Holiday",
    "عطلة"
  ],
  [
    "Hourly",
    "بالساعة"
  ],
  [
    "Hourly Activity",
    "النشاط الساعي"
  ],
  [
    "Hourly Rate",
    "الأجر بالساعة"
  ],
  [
    "Hours",
    "الساعات"
  ],
  [
    "ID number",
    "الرقم التعريفي"
  ],
  [
    "IGU",
    "IGU"
  ],
  [
    "IN",
    "دخول"
  ],
  [
    "Import from Excel",
    "استيراد من Excel"
  ],
  [
    "Import from Raw Sheets",
    "استيراد من الألواح الخام"
  ],
  [
    "In Cutting",
    "في القص"
  ],
  [
    "Insulated",
    "معزول"
  ],
  [
    "Invoice #, notes...",
    "رقم الفاتورة، ملاحظات..."
  ],
  [
    "Invoice #, reason...",
    "رقم الفاتورة، السبب..."
  ],
  [
    "Invoice #, supplier name...",
    "رقم الفاتورة، اسم المورد..."
  ],
  [
    "John Smith",
    "John Smith"
  ],
  [
    "Join Date",
    "تاريخ الالتحاق"
  ],
  [
    "Keep Order",
    "إبقاء الطلب"
  ],
  [
    "Kind",
    "النوع"
  ],
  [
    "LOG OUT",
    "تسجيل خروج"
  ],
  [
    "Label",
    "التسمية"
  ],
  [
    "Label (display name)",
    "التسمية (اسم العرض)"
  ],
  [
    "Labels",
    "العناوين"
  ],
  [
    "Lacobel",
    "لاكوبيل"
  ],
  [
    "Laminated",
    "مصفح"
  ],
  [
    "Laminating",
    "التصفيح"
  ],
  [
    "Last Accrued",
    "آخر استحقاق"
  ],
  [
    "Last Active",
    "آخر نشاط"
  ],
  [
    "Last Month",
    "الشهر الماضي"
  ],
  [
    "Last Week",
    "الأسبوع الماضي"
  ],
  [
    "Late",
    "متأخر"
  ],
  [
    "Late (min)",
    "التأخير (دقيقة)"
  ],
  [
    "Leave",
    "إجازة"
  ],
  [
    "Leave Kind",
    "نوع الإجازة"
  ],
  [
    "Leave Requests",
    "طلبات الإجازات"
  ],
  [
    "Leave Types",
    "أنواع الإجازات"
  ],
  [
    "Leaves (h)",
    "الإجازات (ساعة)"
  ],
  [
    "Left (L)",
    "يسار (L)"
  ],
  [
    "Lin m",
    "متر طولي"
  ],
  [
    "Load",
    "تحميل"
  ],
  [
    "Load Orders",
    "تحميل الطلبات"
  ],
  [
    "Load Selected",
    "تحميل المحدد"
  ],
  [
    "Location, capacity...",
    "الموقع، السعة..."
  ],
  [
    "Lock this month &amp; reset balances",
    "إغلاق هذا الشهر وإعادة ضبط الأرصدة"
  ],
  [
    "Low Iron",
    "منخفض الحديد"
  ],
  [
    "Low Stock Types",
    "الأنواع ذات المخزون المنخفض"
  ],
  [
    "Manage glass storage slots",
    "إدارة فتحات تخزين الزجاج"
  ],
  [
    "Manage optimization sessions",
    "إدارة جلسات التحسين"
  ],
  [
    "Manual Cut",
    "قص يدوي"
  ],
  [
    "Manual Cut (Remnants)",
    "قص يدوي (بقايا)"
  ],
  [
    "Manual Cut / Remnant",
    "قص يدوي / بقية"
  ],
  [
    "Mark Complete",
    "تحديد كمنجز"
  ],
  [
    "Mark Used",
    "تحديد كمستخدم"
  ],
  [
    "Mark as Used",
    "تحديد كمستخدم"
  ],
  [
    "Material Code *",
    "رمز المادة *"
  ],
  [
    "Max Efficiency",
    "أقصى كفاءة"
  ],
  [
    "Medical Report",
    "تقرير طبي"
  ],
  [
    "Min Cut Width (mm)",
    "أقل عرض قص (مم)"
  ],
  [
    "Mirror",
    "مرايا"
  ],
  [
    "Missing AR",
    "ترجمة عربية مفقودة"
  ],
  [
    "Mixed",
    "مختلط"
  ],
  [
    "Monthly Salary",
    "الراتب الشهري"
  ],
  [
    "My Glass Factory",
    "مصنع الزجاج"
  ],
  [
    "Name",
    "الاسم"
  ],
  [
    "National ID",
    "الرقم الوطني"
  ],
  [
    "Net Pay",
    "صافي الراتب"
  ],
  [
    "New Optimization",
    "تحسين جديد"
  ],
  [
    "New Order",
    "طلب جديد"
  ],
  [
    "New password...",
    "كلمة سر جديدة..."
  ],
  [
    "No cancel reasons yet",
    "لا توجد أسباب إلغاء بعد"
  ],
  [
    "No customers",
    "لا يوجد عملاء"
  ],
  [
    "No open orders",
    "لا توجد طلبات مفتوحة"
  ],
  [
    "No orders match filter",
    "لا توجد طلبات مطابقة للمرشح"
  ],
  [
    "No orders match filters",
    "لا توجد طلبات مطابقة للمرشحات"
  ],
  [
    "No orders match this filter",
    "لا توجد طلبات مطابقة لهذا المرشح"
  ],
  [
    "No pending orders",
    "لا توجد طلبات معلقة"
  ],
  [
    "No pieces in queue",
    "لا توجد قطع في القائمة"
  ],
  [
    "No pieces placed",
    "لم توضع قطع"
  ],
  [
    "No sheets added",
    "لم تضف ألواح"
  ],
  [
    "No sheets match filters",
    "لا توجد ألواح مطابقة للمرشحات"
  ],
  [
    "No slot",
    "لا توجد فتحة"
  ],
  [
    "No type reasons yet",
    "لا توجد أسباب نوع بعد"
  ],
  [
    "No workers added",
    "لم يُضف عمال"
  ],
  [
    "No workers yet",
    "لا يوجد عمال بعد"
  ],
  [
    "Normal",
    "عادي"
  ],
  [
    "Note",
    "ملاحظة"
  ],
  [
    "Note (optional)",
    "ملاحظة (اختياري)"
  ],
  [
    "Notes",
    "ملاحظات"
  ],
  [
    "Notes (optional)",
    "ملاحظات (اختياري)"
  ],
  [
    "Notes / Description",
    "ملاحظات / وصف"
  ],
  [
    "ORDER",
    "الطلب"
  ],
  [
    "ORDER SIZE",
    "قياس الطلب"
  ],
  [
    "ORDER STATUS",
    "حالة الطلب"
  ],
  [
    "OT",
    "إضافي"
  ],
  [
    "OT Mins",
    "دقائق إضافية"
  ],
  [
    "OUT",
    "خروج"
  ],
  [
    "Open",
    "مفتوح"
  ],
  [
    "Open + Undelivered",
    "مفتوح + غير مسلم"
  ],
  [
    "Open Orders",
    "الطلبات المفتوحة"
  ],
  [
    "Open Orders — Process Status",
    "الطلبات المفتوحة — حالة المعالجة"
  ],
  [
    "Open in Tab",
    "فتح في تبويب"
  ],
  [
    "Opening",
    "جار الفتح"
  ],
  [
    "Opt #",
    "تحسين #"
  ],
  [
    "Opt Cut",
    "قص التحسين"
  ],
  [
    "Opt Deductions",
    "خصومات التحسين"
  ],
  [
    "Optimization",
    "التحسين"
  ],
  [
    "Optimization Files",
    "ملفات التحسين"
  ],
  [
    "Optimization Strategy",
    "إستراتيجية التحسين"
  ],
  [
    "Optional notes...",
    "ملاحظات اختيارية..."
  ],
  [
    "Or type custom reason...",
    "أو اكتب سبباً مخصصاً..."
  ],
  [
    "Order",
    "الطلب"
  ],
  [
    "Order #",
    "رقم الطلب"
  ],
  [
    "Order Date",
    "تاريخ الطلب"
  ],
  [
    "Order Ref",
    "مرجع الطلب"
  ],
  [
    "Order Ref (auto)",
    "مرجع الطلب (تلقائي)"
  ],
  [
    "Order SQM",
    "م² الطلب"
  ],
  [
    "Order Size",
    "قياس الطلب"
  ],
  [
    "Order Summary",
    "ملخص الطلب"
  ],
  [
    "Order Tracking",
    "متابعة الطلبات"
  ],
  [
    "Order Type",
    "نوع الطلب"
  ],
  [
    "Order Type Reasons",
    "أسباب نوع الطلب"
  ],
  [
    "Order Types",
    "أنواع الطلبات"
  ],
  [
    "Order View",
    "عرض الطلبات"
  ],
  [
    "Order, sheet, name...",
    "طلب، لوح، اسم..."
  ],
  [
    "Orders",
    "الطلبات"
  ],
  [
    "Orders by Final Product",
    "الطلبات حسب المنتج النهائي"
  ],
  [
    "Orig UID",
    "المعرف الأصلي"
  ],
  [
    "Origin (المنشأ)",
    "المنشأ"
  ],
  [
    "Origin / Country",
    "المنشأ / الدولة"
  ],
  [
    "Origin Country",
    "دولة المنشأ"
  ],
  [
    "Other",
    "أخرى"
  ],
  [
    "Overtime",
    "العمل الإضافي"
  ],
  [
    "Overtime Requests",
    "طلبات العمل الإضافي"
  ],
  [
    "PDF",
    "PDF"
  ],
  [
    "PIECE ID",
    "معرف القطعة"
  ],
  [
    "PIECE REF",
    "مرجع القطعة"
  ],
  [
    "PIECE UID",
    "معرف القطعة الفريد"
  ],
  [
    "PIECES",
    "القطع"
  ],
  [
    "PROCESSES",
    "العمليات"
  ],
  [
    "Paint",
    "دهان"
  ],
  [
    "Paint Color (لون الدهان)",
    "لون الدهان"
  ],
  [
    "Passport",
    "جواز سفر"
  ],
  [
    "Password",
    "كلمة السر"
  ],
  [
    "Password *",
    "كلمة السر *"
  ],
  [
    "Payroll",
    "الرواتب"
  ],
  [
    "Payroll Adjustments",
    "تعديلات الرواتب"
  ],
  [
    "Pcs",
    "قطع"
  ],
  [
    "Penalty (-)",
    "خصم (-)"
  ],
  [
    "Pending",
    "معلق"
  ],
  [
    "Pending OT",
    "عمل إضافي معلق"
  ],
  [
    "Pending Overtime Requests",
    "طلبات العمل الإضافي المعلقة"
  ],
  [
    "Personal",
    "شخصي"
  ],
  [
    "Phone",
    "الهاتف"
  ],
  [
    "Phone *",
    "الهاتف *"
  ],
  [
    "Piece Detail",
    "تفاصيل القطعة"
  ],
  [
    "Piece ID",
    "معرف القطعة"
  ],
  [
    "Piece Ref",
    "مرجع القطعة"
  ],
  [
    "Piece Reference *",
    "مرجع القطعة *"
  ],
  [
    "Piece View",
    "عرض القطع"
  ],
  [
    "Pieces",
    "القطع"
  ],
  [
    "Placed / Total",
    "موضوعة / الإجمالي"
  ],
  [
    "Poly",
    "بولي"
  ],
  [
    "Preserve Length",
    "الحفاظ على الطول"
  ],
  [
    "Preserve Width",
    "الحفاظ على العرض"
  ],
  [
    "Print",
    "طباعة"
  ],
  [
    "Print Attachments",
    "طباعة المرفقات"
  ],
  [
    "Print Labels",
    "طباعة العناوين"
  ],
  [
    "Print Order",
    "طباعة الطلب"
  ],
  [
    "Print Pieces Only",
    "طباعة القطع فقط"
  ],
  [
    "Print attachments",
    "طباعة المرفقات"
  ],
  [
    "Print order details",
    "طباعة تفاصيل الطلب"
  ],
  [
    "Process",
    "العملية"
  ],
  [
    "Process (عمليات)",
    "العملية"
  ],
  [
    "Process Permissions",
    "صلاحيات العمليات"
  ],
  [
    "Process status",
    "حالة العملية"
  ],
  [
    "Processes",
    "العمليات"
  ],
  [
    "Processes Responsible For",
    "العمليات المسؤول عنها"
  ],
  [
    "Productivity",
    "الإنتاجية"
  ],
  [
    "Project / Notes",
    "المشروع / ملاحظات"
  ],
  [
    "Punch In",
    "دخول"
  ],
  [
    "Punch Out",
    "خروج"
  ],
  [
    "Punch-In Tolerance (mins late before marked late)",
    "هامش التأخير (دقائق قبل اعتبار التأخر)"
  ],
  [
    "Punch-Out Grace (mins after shift end before overtime)",
    "هامش الخروج (دقائق بعد انتهاء الوردية قبل العمل الإضافي)"
  ],
  [
    "Purchase",
    "شراء"
  ],
  [
    "Purchase History",
    "تاريخ الشراء"
  ],
  [
    "Purchased",
    "مشترى"
  ],
  [
    "Push pieces here to cut from remnant plates",
    "ادفع القطع هنا للقص من ألواح البقايا"
  ],
  [
    "QR Labels are now part of Cutting Optimization",
    "عناوين QR أصبحت جزءاً من تحسين القص"
  ],
  [
    "Qty",
    "الكمية"
  ],
  [
    "Quantity",
    "الكمية"
  ],
  [
    "Quantity (sheets)",
    "الكمية (ألواح)"
  ],
  [
    "Quick add purchase",
    "إضافة شراء سريعة"
  ],
  [
    "RAW SHEET",
    "اللوح الخام"
  ],
  [
    "RECEIVER",
    "المستلم"
  ],
  [
    "REF",
    "مرجع"
  ],
  [
    "ROT",
    "دوران"
  ],
  [
    "Raw Materials",
    "المواد الخام"
  ],
  [
    "Raw Materials, Workers and System",
    "المواد الخام والعمال والنظام"
  ],
  [
    "Raw Sheet",
    "اللوح الخام"
  ],
  [
    "Raw Sheet Catalog",
    "كتالوج الألواح الخام"
  ],
  [
    "Raw Sheet Type",
    "نوع اللوح الخام"
  ],
  [
    "Raw Sheets",
    "الألواح الخام"
  ],
  [
    "Reason",
    "السبب"
  ],
  [
    "Reason for adjustment",
    "سبب التعديل"
  ],
  [
    "Reason for adjustment or rejection",
    "سبب التعديل أو الرفض"
  ],
  [
    "Reason or notes",
    "السبب أو ملاحظات"
  ],
  [
    "Receivers",
    "المستلمون"
  ],
  [
    "Recent Orders",
    "الطلبات الأخيرة"
  ],
  [
    "Record Purchase / Receipt",
    "تسجيل شراء / استلام"
  ],
  [
    "Recovered SQM",
    "م² المسترد"
  ],
  [
    "Reference / Notes",
    "مرجع / ملاحظات"
  ],
  [
    "Refresh",
    "تحديث"
  ],
  [
    "Reject",
    "رفض"
  ],
  [
    "Rejected",
    "مرفوض"
  ],
  [
    "Remaining",
    "متبقي"
  ],
  [
    "Remake Notes",
    "ملاحظات إعادة الصنع"
  ],
  [
    "Remnant Plates",
    "ألواح البقايا"
  ],
  [
    "Remnant Slots",
    "فتحات البقايا"
  ],
  [
    "Remnant Storage Slots",
    "فتحات تخزين البقايا"
  ],
  [
    "Remnants",
    "البقايا"
  ],
  [
    "Remnants Stored",
    "البقايا المخزنة"
  ],
  [
    "Remove",
    "إزالة"
  ],
  [
    "Reopen",
    "إعادة فتح"
  ],
  [
    "Reports",
    "التقارير"
  ],
  [
    "Requires File",
    "يتطلب ملف"
  ],
  [
    "Reset Device",
    "إعادة تعيين الجهاز"
  ],
  [
    "Reset zoom",
    "إعادة تعيين التكبير"
  ],
  [
    "Review",
    "مراجعة"
  ],
  [
    "Right (R)",
    "يمين (R)"
  ],
  [
    "Role",
    "الدور"
  ],
  [
    "Role / Access Level",
    "الدور / مستوى الصلاحية"
  ],
  [
    "Rot",
    "دوران"
  ],
  [
    "Rotate",
    "تدوير"
  ],
  [
    "Rotate 90° clockwise",
    "تدوير 90° مع عقارب الساعة"
  ],
  [
    "SCANNED BY",
    "مسح بواسطة"
  ],
  [
    "SERIAL",
    "التسلسل"
  ],
  [
    "SIGN IN",
    "تسجيل الدخول"
  ],
  [
    "SIZE",
    "القياس"
  ],
  [
    "SIZE (mm)",
    "القياس (مم)"
  ],
  [
    "SLOTS &amp; QUANTITIES",
    "الفتحات والكميات"
  ],
  [
    "SQM",
    "م²"
  ],
  [
    "SQM &#8597;",
    "م² ↕"
  ],
  [
    "SQM Cut",
    "م² مقصوص"
  ],
  [
    "SS",
    "ض.ا"
  ],
  [
    "STATUS",
    "الحالة"
  ],
  [
    "Saint-Gobain",
    "سان جوبان"
  ],
  [
    "Sale",
    "بيع"
  ],
  [
    "Sample",
    "عينة"
  ],
  [
    "Sand Blasting",
    "رمل ساتر"
  ],
  [
    "Saturday",
    "السبت"
  ],
  [
    "Save",
    "حفظ"
  ],
  [
    "Save Access Settings",
    "حفظ إعدادات الصلاحيات"
  ],
  [
    "Save All Remnants",
    "حفظ كل البقايا"
  ],
  [
    "Save Config",
    "حفظ الإعدادات"
  ],
  [
    "Save Customer",
    "حفظ العميل"
  ],
  [
    "Save Deductions",
    "حفظ الخصومات"
  ],
  [
    "Save Employment Info",
    "حفظ بيانات التوظيف"
  ],
  [
    "Save Entry",
    "حفظ القيد"
  ],
  [
    "Save Order",
    "حفظ الطلب"
  ],
  [
    "Save Personal Info",
    "حفظ البيانات الشخصية"
  ],
  [
    "Save Remnant",
    "حفظ البقية"
  ],
  [
    "Save Schedule",
    "حفظ الجدول"
  ],
  [
    "Save Slot",
    "حفظ الفتحة"
  ],
  [
    "Save Worker",
    "حفظ العامل"
  ],
  [
    "Schedule",
    "الجدول"
  ],
  [
    "Search UID, slot, source...",
    "بحث بالمعرف، الفتحة، المصدر..."
  ],
  [
    "Search order or ext ref...",
    "بحث بالطلب أو المرجع الخارجي..."
  ],
  [
    "Search serial, customer...",
    "بحث بالتسلسل، العميل..."
  ],
  [
    "Search sheet...",
    "بحث بالألواح..."
  ],
  [
    "Search...",
    "بحث..."
  ],
  [
    "Section",
    "القسم"
  ],
  [
    "Select Raw Sheet for this Session",
    "اختر اللوح الخام لهذه الجلسة"
  ],
  [
    "Select customer...",
    "اختر العميل..."
  ],
  [
    "Select thickness / type / color...",
    "اختر السماكة / النوع / اللون..."
  ],
  [
    "Send to Cutting",
    "إرسال للقص"
  ],
  [
    "Send to cutting",
    "إرسال للقص"
  ],
  [
    "Set password",
    "تعيين كلمة السر"
  ],
  [
    "Settings",
    "الإعدادات"
  ],
  [
    "Sheet",
    "اللوح"
  ],
  [
    "Sheet Catalog",
    "كتالوج الألواح"
  ],
  [
    "Sheet Code",
    "رمز اللوح"
  ],
  [
    "Sheet SQM",
    "م² اللوح"
  ],
  [
    "Sheet Usage per Optimization File",
    "استخدام الألواح لكل ملف تحسين"
  ],
  [
    "Sheet Used",
    "اللوح المستخدم"
  ],
  [
    "Sheets & Slots Overview",
    "نظرة عامة على الألواح والفتحات"
  ],
  [
    "Sheets Used",
    "الألواح المستخدمة"
  ],
  [
    "Sheets Used (#)",
    "الألواح المستخدمة (#)"
  ],
  [
    "Sheets Used (Total)",
    "الألواح المستخدمة (الإجمالي)"
  ],
  [
    "Side",
    "الجانب"
  ],
  [
    "Silver",
    "فضي"
  ],
  [
    "Size",
    "القياس"
  ],
  [
    "Skip",
    "تخطي"
  ],
  [
    "Slot",
    "الفتحة"
  ],
  [
    "Slot &#8597;",
    "الفتحة ↕"
  ],
  [
    "Slot Breakdown",
    "تفاصيل الفتحات"
  ],
  [
    "Slot Code",
    "رمز الفتحة"
  ],
  [
    "Slot Code *",
    "رمز الفتحة *"
  ],
  [
    "Slot Management",
    "إدارة الفتحات"
  ],
  [
    "Slot Name (auto-generated)",
    "اسم الفتحة (مولّد تلقائياً)"
  ],
  [
    "Slots &amp; Quantities",
    "الفتحات والكميات"
  ],
  [
    "Sort Order",
    "ترتيب الفرز"
  ],
  [
    "Source",
    "المصدر"
  ],
  [
    "Source / Notes",
    "المصدر / ملاحظات"
  ],
  [
    "Start Time",
    "وقت البداية"
  ],
  [
    "Status",
    "الحالة"
  ],
  [
    "Stock Balance per Sheet Type",
    "رصيد المخزون لكل نوع لوح"
  ],
  [
    "Stock Ledger",
    "سجل المخزون"
  ],
  [
    "Storage Slot",
    "فتحة تخزين"
  ],
  [
    "Storage remnant",
    "بقية تخزين"
  ],
  [
    "Sub-type (صنف2)",
    "صنف فرعي"
  ],
  [
    "Sunday",
    "الأحد"
  ],
  [
    "Supplier / Notes",
    "المورد / ملاحظات"
  ],
  [
    "Sync to Google Sheets",
    "مزامنة مع جوجل شيتس"
  ],
  [
    "System",
    "النظام"
  ],
  [
    "THICKNESS",
    "السماكة"
  ],
  [
    "TIME",
    "الوقت"
  ],
  [
    "TOTAL",
    "الإجمالي"
  ],
  [
    "Tempered",
    "مقسى"
  ],
  [
    "Tempered (سيكوريت)",
    "مقسى (سيكوريت)"
  ],
  [
    "Tempering",
    "التقسية"
  ],
  [
    "Template",
    "قالب"
  ],
  [
    "Thick",
    "السماكة"
  ],
  [
    "Thickness",
    "السماكة"
  ],
  [
    "Thickness &#8597;",
    "السماكة ↕"
  ],
  [
    "Thickness (mm)",
    "السماكة (مم)"
  ],
  [
    "Thickness (السماكة)",
    "السماكة"
  ],
  [
    "Thickness mm",
    "السماكة مم"
  ],
  [
    "This Month",
    "هذا الشهر"
  ],
  [
    "This Optimization",
    "هذا التحسين"
  ],
  [
    "This Week",
    "هذا الأسبوع"
  ],
  [
    "To",
    "إلى"
  ],
  [
    "Today",
    "اليوم"
  ],
  [
    "Total",
    "الإجمالي"
  ],
  [
    "Total Pieces",
    "إجمالي القطع"
  ],
  [
    "Total Purchased",
    "إجمالي المشتريات"
  ],
  [
    "Total SQM",
    "إجمالي م²"
  ],
  [
    "Total Used",
    "إجمالي المستخدم"
  ],
  [
    "Track",
    "تتبع"
  ],
  [
    "Tracking",
    "المتابعة"
  ],
  [
    "Transfer",
    "تحويل"
  ],
  [
    "Translation Library",
    "مكتبة الترجمة"
  ],
  [
    "Translations",
    "الترجمات"
  ],
  [
    "Type",
    "النوع"
  ],
  [
    "Type &#8597;",
    "النوع ↕"
  ],
  [
    "Type / Color / Thick",
    "النوع / اللون / السماكة"
  ],
  [
    "Type order number...",
    "اكتب رقم الطلب..."
  ],
  [
    "Type/Color",
    "النوع/اللون"
  ],
  [
    "UID",
    "المعرف الفريد"
  ],
  [
    "Unassigned",
    "غير معين"
  ],
  [
    "Uncancel",
    "إلغاء الإلغاء"
  ],
  [
    "Unlock — will restore balance",
    "فتح — سيعيد الرصيد"
  ],
  [
    "Unpaid Leave",
    "إجازة بدون أجر"
  ],
  [
    "Unsaved",
    "غير محفوظ"
  ],
  [
    "Usage by Optimization",
    "الاستخدام حسب التحسين"
  ],
  [
    "Use This",
    "استخدم هذا"
  ],
  [
    "Used",
    "مستخدم"
  ],
  [
    "Used (Opts)",
    "مستخدم (تحسينات)"
  ],
  [
    "Vacation",
    "إجازة"
  ],
  [
    "Vacation Balance",
    "رصيد الإجازات"
  ],
  [
    "Vacation Days Balance",
    "رصيد أيام الإجازة"
  ],
  [
    "View",
    "عرض"
  ],
  [
    "View in Tracking",
    "عرض في المتابعة"
  ],
  [
    "View medical report",
    "عرض التقرير الطبي"
  ],
  [
    "View order",
    "عرض الطلب"
  ],
  [
    "W x H",
    "عرض × طول"
  ],
  [
    "W × H (mm)",
    "عرض × طول (مم)"
  ],
  [
    "Warranty",
    "ضمان"
  ],
  [
    "Waste",
    "هدر"
  ],
  [
    "Weekend",
    "عطلة أسبوعية"
  ],
  [
    "Weekend Day",
    "يوم العطلة"
  ],
  [
    "White",
    "أبيض"
  ],
  [
    "Width (mm)",
    "العرض (مم)"
  ],
  [
    "Width add (mm)",
    "إضافة العرض (مم)"
  ],
  [
    "Width mm",
    "العرض مم"
  ],
  [
    "Worker",
    "العامل"
  ],
  [
    "Worker Attendance",
    "دوام العامل"
  ],
  [
    "Worker Productivity",
    "إنتاجية العامل"
  ],
  [
    "Workers",
    "العمال"
  ],
  [
    "Working Hours",
    "ساعات العمل"
  ],
  [
    "W×H &#8597;",
    "عرض×طول ↕"
  ],
  [
    "Yesterday",
    "أمس"
  ],
  [
    "Zoom in",
    "تكبير"
  ],
  [
    "Zoom out",
    "تصغير"
  ],
  [
    "e.g. 10",
    "مثل 10"
  ],
  [
    "e.g. 10 or -5",
    "مثل 10 أو -5"
  ],
  [
    "e.g. 1200",
    "مثل 1200"
  ],
  [
    "e.g. 2",
    "مثل 2"
  ],
  [
    "e.g. 50 or -25",
    "مثل 50 أو -25"
  ],
  [
    "e.g. 6",
    "مثل 6"
  ],
  [
    "e.g. 6mm Clear Glass",
    "مثل زجاج شفاف 6 مم"
  ],
  [
    "e.g. 800",
    "مثل 800"
  ],
  [
    "e.g. A1, B3, C12",
    "مثل A1, B3, C12"
  ],
  [
    "e.g. AGC, Saint Gobain",
    "مثل AGC، سان جوبان"
  ],
  [
    "e.g. Belgian, Chinese",
    "مثل بلجيكي، صيني"
  ],
  [
    "e.g. From opt file REF-1 2026-03-28",
    "مثل من ملف تحسين REF-1 2026-03-28"
  ],
  [
    "e.g. Passport #A1234567",
    "مثل جواز سفر #A1234567"
  ],
  [
    "e.g. REF-1-5",
    "مثل REF-1-5"
  ],
  [
    "e.g. REF-1-5, REF-2-3",
    "مثل REF-1-5, REF-2-3"
  ],
  [
    "e.g. Rack A, Row 1",
    "مثل رف A، صف 1"
  ],
  [
    "— Select or type to search —",
    "— اختر أو اكتب للبحث —"
  ]
];

const stmt = db.prepare(`INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, 'ui') ON CONFLICT(key) DO UPDATE SET ar = excluded.ar, updated_at = CURRENT_TIMESTAMP`);
const txn = db.transaction((rows) => { for (const [k, a] of rows) stmt.run(k, k, a); });
txn(seed);
console.log('Seeded ' + seed.length + ' translations.');