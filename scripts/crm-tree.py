"""Draws the BMU Hub CRM structure as tree diagrams into a landscape A4 PDF."""
import sys
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white

OUT = sys.argv[1]
W, H = landscape(A4)
M = 36  # page margin

NAVY = HexColor("#131F2E")
GREEN = HexColor("#7DB935")
INK = HexColor("#1F2933")
MUTED = HexColor("#5F6B7A")
LINE = HexColor("#9AA5B1")
SOFT = HexColor("#F2F5F8")
BORDER = HexColor("#D5DCE3")

# Access tags shown next to Command Centre pages (who can open them besides everyone in the Command Centre).
TAGS = {
    "FA": ("FA", HexColor("#C0392B"), "Founder & Admin only"),
    "$": ("$", HexColor("#B7791F"), "+ Finance"),
    "P": ("P", HexColor("#6B46C1"), "+ HR/Ops & Dept Head"),
    "L": ("L", HexColor("#2B6CB0"), "+ AM Lead & Dept Head"),
    "N": ("N", HexColor("#2F855A"), "all except HR/Ops"),
}

c = canvas.Canvas(OUT, pagesize=(W, H))
c.setTitle("BMU Hub - CRM Tree")
c.setAuthor("BMU Marketing")
c.setSubject("Structure of the BMU Hub CRM: surfaces, roles and pages")
page_no = [0]


def header(title, subtitle):
    page_no[0] += 1
    c.setFillColor(NAVY)
    c.rect(0, H - 54, W, 54, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 17)
    c.drawString(M, H - 34, title)
    c.setFont("Helvetica", 9.5)
    c.setFillColor(HexColor("#C9D3DD"))
    c.drawRightString(W - M, H - 34, subtitle)
    c.setFillColor(GREEN)
    c.rect(0, H - 57, W, 3, stroke=0, fill=1)
    c.setFont("Helvetica", 8)
    c.setFillColor(MUTED)
    c.drawString(M, 18, "BMU Hub CRM structure  |  generated from the code base (apps/web, packages/shared)  |  9 Oct 2026")
    c.drawRightString(W - M, 18, f"Page {page_no[0]}")


def box(x, y, w, h, title, sub=None, fill=SOFT, stroke=BORDER, tcol=INK, bold=True, size=9):
    """Box centred horizontally on x, top edge at y."""
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.8)
    c.roundRect(x - w / 2, y - h, w, h, 4, stroke=1, fill=1)
    c.setFillColor(tcol)
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    lines = title.split("\n")
    total = len(lines) * (size + 1.5) + (len(sub.split("\n")) * 8.5 if sub else 0)
    ty = y - (h - total) / 2 - size + 1
    for ln in lines:
        c.drawCentredString(x, ty, ln)
        ty -= size + 1.5
    if sub:
        c.setFont("Helvetica", 7)
        c.setFillColor(MUTED if fill == SOFT or fill == white else HexColor("#DCE4EC"))
        for ln in sub.split("\n"):
            c.drawCentredString(x, ty + 1, ln)
            ty -= 8.5


def elbow(x1, y1, x2, y2):
    """Parent bottom (x1,y1) to child top (x2,y2) with a right-angled connector."""
    c.setStrokeColor(LINE)
    c.setLineWidth(0.9)
    mid = (y1 + y2) / 2
    p = c.beginPath()
    p.moveTo(x1, y1)
    p.lineTo(x1, mid)
    p.lineTo(x2, mid)
    p.lineTo(x2, y2)
    c.drawPath(p, stroke=1, fill=0)


# ---------- top-down org chart ----------
def width_of(n, bw, gap):
    kids = n.get("kids", [])
    if not kids:
        return n.get("w", bw)
    return max(n.get("w", bw), sum(width_of(k, bw, gap) for k in kids) + gap * (len(kids) - 1))


def org(n, cx, top, bw, bh, gap, vgap):
    w = n.get("w", bw)
    fill = n.get("fill", SOFT)
    box(cx, top, w, n.get("h", bh), n["t"], n.get("s"), fill=fill,
        stroke=n.get("stroke", BORDER), tcol=n.get("tcol", INK), size=n.get("size", 8.5))
    kids = n.get("kids", [])
    if not kids:
        return
    total = sum(width_of(k, bw, gap) for k in kids) + gap * (len(kids) - 1)
    x = cx - total / 2
    for k in kids:
        kw = width_of(k, bw, gap)
        kx = x + kw / 2
        elbow(cx, top - n.get("h", bh), kx, top - n.get("h", bh) - vgap)
        org(k, kx, top - n.get("h", bh) - vgap, bw, bh, gap, vgap)
        x += kw + gap


# ---------- left-to-right outline tree (section -> pages) ----------
def outline(x, y, title, items, colw, row=11.2, title_fill=NAVY):
    """Section box at (x, y top-left), pages listed beneath with branch lines. Returns bottom y."""
    c.setFillColor(title_fill)
    c.roundRect(x, y - 16, colw, 16, 3, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8.6)
    c.drawString(x + 6, y - 11.5, title)
    c.setFillColor(HexColor("#C9D3DD"))
    c.setFont("Helvetica", 7)
    c.drawRightString(x + colw - 6, y - 11.5, str(len(items)))
    trunk = x + 8
    cy = y - 16 - row + 3
    last = cy
    for it in items:
        label, tag = (it if isinstance(it, tuple) else (it, None))
        c.setStrokeColor(LINE)
        c.setLineWidth(0.8)
        c.line(trunk, cy + 3, trunk + 8, cy + 3)
        c.setFillColor(INK)
        c.setFont("Helvetica", 7.8)
        c.drawString(trunk + 11, cy, label)
        if tag:
            t, col, _ = TAGS[tag]
            tw = c.stringWidth(label, "Helvetica", 7.8)
            bx = trunk + 11 + tw + 4
            c.setFillColor(col)
            c.roundRect(bx, cy - 1.5, max(9, c.stringWidth(t, "Helvetica-Bold", 6) + 5), 8.5, 2, stroke=0, fill=1)
            c.setFillColor(white)
            c.setFont("Helvetica-Bold", 6)
            c.drawCentredString(bx + max(9, c.stringWidth(t, "Helvetica-Bold", 6) + 5) / 2, cy + 0.5, t)
        last = cy
        cy -= row
    c.setStrokeColor(LINE)
    c.line(trunk, y - 16, trunk, last + 3)
    return cy


def columns(sections, top, ncols, gap=14, row=10.6, sec_gap=9, colw=None):
    """Flow sections into columns, top to bottom, left to right."""
    colw = colw or (W - 2 * M - gap * (ncols - 1)) / ncols
    col, y = 0, top
    for sec in sections:
        if sec is None:  # forced column break
            col, y = col + 1, top
            continue
        title, items = sec
        need = 16 + len(items) * row + sec_gap
        if y - need < 30 and y != top:
            col += 1
            y = top
        x = M + col * (colw + gap)
        y = outline(x, y, title, items, colw, row) - sec_gap + row
    return col


def legend(x, y, keys):
    c.setFont("Helvetica-Bold", 7.5)
    c.setFillColor(INK)
    c.drawString(x, y, "Who can open it:")
    x += c.stringWidth("Who can open it:", "Helvetica-Bold", 7.5) + 8
    for k in keys:
        t, col, desc = TAGS[k]
        c.setFillColor(col)
        c.roundRect(x, y - 1.5, 10, 8.5, 2, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 6)
        c.drawCentredString(x + 5, y + 0.5, t)
        c.setFillColor(INK)
        c.setFont("Helvetica", 7.5)
        c.drawString(x + 13, y, desc)
        x += 13 + c.stringWidth(desc, "Helvetica", 7.5) + 14
    c.setFillColor(MUTED)
    c.drawString(x, y, "No tag = everyone with Command Centre access.")


# =========================================================== PAGE 1: overview
header("BMU Hub - CRM Tree", "Overview: the parts of the CRM and who uses them")
dark = dict(fill=NAVY, stroke=NAVY, tcol=white)
greenbox = dict(fill=GREEN, stroke=GREEN, tcol=white)
overview = {
    "t": "BMU Hub CRM", "s": "one login, a different workspace per role", "w": 190, "h": 34, "size": 11, **dark,
    "kids": [
        {"t": "Public website", "s": "/  (no login)", "w": 118, **greenbox, "kids": [
            {"t": "Services &\npackage builder", "w": 118, "h": 30},
            {"t": "Enquiry &\nbook a call", "w": 118, "h": 30},
            {"t": "Proposal, agreement\n& payment links", "w": 118, "h": 30},
            {"t": "Sign in", "s": "email / mobile code\nor passkey", "w": 118, "h": 38},
        ]},
        {"t": "Team app", "s": "/team  (all staff)", "w": 118, **greenbox, "kids": [
            {"t": "Work", "s": "leads, proposals, tasks,\nQC, projects, messages", "w": 118, "h": 38},
            {"t": "Plan", "s": "calendars, capacity,\nworkload, SOPs", "w": 118, "h": 38},
            {"t": "You", "s": "performance, timesheet,\nexpenses, leave", "w": 118, "h": 38},
        ]},
        {"t": "Command Centre", "s": "/admin  (admin roles)", "w": 124, **greenbox, "kids": [
            {"t": "13 sections", "s": "~90 pages: command,\nanalytics, flow, AI,\norganisation, clients,\ncatalogue, operations,\nfinance, platform", "w": 124, "h": 70},
        ]},
        {"t": "Client portal", "s": "/client  (customers)", "w": 118, **greenbox, "kids": [
            {"t": "Your account", "s": "journey, approvals,\nreviews, files, billing,\nreports, messages", "w": 118, "h": 46},
            {"t": "Settings", "s": "services, team users,\nprofile", "w": 118, "h": 38},
        ]},
        {"t": "Creator portal", "s": "/creator  (UGC creators)", "w": 118, **greenbox, "kids": [
            {"t": "Your work", "s": "briefs, revisions,\npayouts", "w": 118, "h": 38},
            {"t": "You", "s": "profile", "w": 118, "h": 30},
        ]},
    ],
}


def org_v(n, cx, top, gap=8, vgap=22):
    """Org chart whose second level stacks its children vertically (keeps wide trees on one page)."""
    w, h = n.get("w", 120), n.get("h", 32)
    box(cx, top, w, h, n["t"], n.get("s"), fill=n.get("fill", SOFT), stroke=n.get("stroke", BORDER), tcol=n.get("tcol", INK), size=n.get("size", 9))
    kids = n["kids"]
    total = sum(k.get("w", 120) for k in kids) + 22 * (len(kids) - 1)
    x = cx - total / 2
    for k in kids:
        kw = k.get("w", 120)
        kx = x + kw / 2
        ktop = top - h - vgap
        elbow(cx, top - h, kx, ktop)
        kh = k.get("h", 32)
        box(kx, ktop, kw, kh, k["t"], k.get("s"), fill=k.get("fill", SOFT), stroke=k.get("stroke", BORDER), tcol=k.get("tcol", INK), size=9)
        y = ktop - kh - 12
        rail = kx - kw / 2 - 7
        c.setStrokeColor(LINE)
        c.setLineWidth(0.9)
        c.line(kx - kw / 2 + 10, ktop - kh, kx - kw / 2 + 10, ktop - kh - 6)
        c.line(kx - kw / 2 + 10, ktop - kh - 6, rail, ktop - kh - 6)
        last_mid = None
        for g in k["kids"]:
            gh = g.get("h", 30)
            box(kx, y, kw, gh, g["t"], g.get("s"), fill=white, size=8)
            last_mid = y - gh / 2
            c.line(rail, last_mid, kx - kw / 2, last_mid)
            y -= gh + 8
        c.line(rail, ktop - kh - 6, rail, last_mid)
        x += kw + 22


org_v(overview, W / 2, H - 82)

# key facts strip
facts = [
    ("Database", "PostgreSQL 17 (local), bmu_hub, 158 tables"),
    ("Sign-in", "6-digit code by email / mobile, or passkey"),
    ("Staff roles", "13 team roles across 12 departments"),
    ("Client roles", "Owner, Approver, Viewer, Finance"),
]
fx = M
fw = (W - 2 * M - 3 * 10) / 4
for k, v in facts:
    c.setFillColor(SOFT)
    c.setStrokeColor(BORDER)
    c.roundRect(fx, 34, fw, 30, 4, stroke=1, fill=1)
    c.setFillColor(GREEN)
    c.rect(fx, 34, 3, 30, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(fx + 10, 52, k)
    c.setFont("Helvetica", 7.6)
    c.setFillColor(MUTED)
    c.drawString(fx + 10, 41, v)
    fx += fw + 10
c.showPage()

# =========================================================== PAGE 2: people hierarchy
header("Who reports to whom", "Team roles (rank 1-7), client roles and departments")
R = lambda t, s, **kw: {"t": t, "s": s, **kw}
roles = R("Founder / Super Admin", "all branches - everything, incl. roles,\npricing, commercial terms", w=170, h=36, **dark, kids=[
    R("Admin / Director", "assigned branches - users, departments,\nclients, settings (not Founder/billing)", w=170, h=36, fill=HexColor("#2C3E50"), stroke=HexColor("#2C3E50"), tcol=white, kids=[
        R("Department Head", "own department: members,\ntemplates, QC, capacity", w=118, h=36, kids=[
            R("Strategist", "plans, calendars", w=70, h=30, size=8),
            R("QC Reviewer", "pass / fail QC", w=70, h=30, size=8),
            R("Producer", "designer, editor,\ndev, SEO, ads, UGC", w=78, h=38, size=8),
            R("Intern", "own tasks", w=56, h=30, size=8),
        ]),
        R("Sales Manager", "lead assignment,\nproposals, discounts", w=100, h=36, kids=[
            R("Sales Executive", "own leads &\nproposals", w=82, h=30, size=8),
        ]),
        R("AM Lead", "AM assignment,\nescalations, health", w=100, h=36, kids=[
            R("Account Manager", "onboarding, comms,\nrequests, drafts", w=86, h=38, size=8),
        ]),
        R("Finance", "invoices, payments,\nGST, payouts", w=88, h=36),
        R("HR / Ops", "people, leave,\nattendance", w=80, h=36),
    ]),
])
org(roles, W / 2 - 20, H - 80, 90, 34, 10, 20)

# client roles + departments
cx0 = M
c.setFont("Helvetica-Bold", 10)
c.setFillColor(INK)
c.drawString(cx0, 156, "Client side (per customer company)")
client_roles = [("Client Owner", "approve plans/work & quotes, pay, manage users"),
                ("Client Approver", "approve creative, raise requests"),
                ("Client Viewer", "view progress, files, reports; comment"),
                ("Client Finance", "view & pay invoices, receipts")]
y = 142
for i, (t, s) in enumerate(client_roles):
    c.setFillColor(GREEN if i == 0 else SOFT)
    c.setStrokeColor(GREEN if i == 0 else BORDER)
    c.roundRect(cx0 + i * 14, y - 18, 300, 18, 3, stroke=1, fill=1)
    c.setFillColor(white if i == 0 else INK)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(cx0 + i * 14 + 7, y - 12, t)
    c.setFont("Helvetica", 7.3)
    c.setFillColor(HexColor("#EAF5DC") if i == 0 else MUTED)
    c.drawString(cx0 + i * 14 + 92, y - 12, s)
    y -= 23

dx = W / 2 + 30
c.setFont("Helvetica-Bold", 10)
c.setFillColor(INK)
c.drawString(dx, 156, "12 departments")
deps = ["Sales", "Account Management", "Strategy", "Creative / Design", "Video / Production", "Web / AI",
        "SEO", "Performance Ads", "Creator / UGC", "QC", "Finance", "HR / Ops"]
for i, d in enumerate(deps):
    col, rw = i % 3, i // 3
    bx = dx + col * 118
    by = 142 - rw * 23
    c.setFillColor(SOFT)
    c.setStrokeColor(BORDER)
    c.roundRect(bx, by - 18, 110, 18, 3, stroke=1, fill=1)
    c.setFillColor(INK)
    c.setFont("Helvetica", 7.8)
    c.drawCentredString(bx + 55, by - 12, d)
c.showPage()

# =========================================================== PAGES 3-4: Command Centre
cc = [
    ("Command", ["Weekly Review", "Pipeline", ("Approvals", "L"), ("Discount Approvals", "FA"), ("Renewals", "FA"), ("Revenue", "$"),
                 ("Collections", "$"), ("Capacity", "N"), "Workload", ("Quality", "N"), ("Client Health", "N")]),
    ("Dashboards", [("Dashboard Studio", "FA")]),
    ("Intelligence", [("Forecast & Risks", "N"), ("Metrics", "N"), "Alerts", "Scheduled Reports", "Goals"]),
    ("Analytics", [("Scorecard", "$"), ("Sales Funnel", "$"), ("Revenue Forecast", "$"), ("MRR & Retention", "$"), ("Profitability", "$"),
                   ("Team Performance", "L"), ("Specialist Dashboards", "L"), ("Delivery Speed", "N"), ("SLA & Response", "N"), ("Report Builder", "N")]),
    ("Flow", [("Business Flow Map", "L"), ("Workflows", "N"), ("Workflow Runs", "N"), ("Automations", "N"), ("Automation Log", "N")]),
    ("Agents (AI)", [("AI Agents", "FA"), "Agent Inbox", ("Agent Run Log", "FA")]),
    ("Customise", [("Custom Fields", "FA"), "Forms (+ Sales Manager)", ("Pipeline Settings", "FA")]),
]
cc2 = [
    ("Organisation", [("Hierarchy Tree", "P"), ("Users", "P"), ("Roles & Permissions", "P"), ("Departments & Teams", "P"), ("Branches", "P"),
                      ("Attendance & Leave", "P"), "Holidays & Working Hours", ("Onboarding & Offboarding", "P"), ("Timesheets", "P")]),
    ("Clients", [("Clients", "N"), "Engagements (FA + AM Lead)", "AM Assignment (FA + AM Lead)", "Requests & Add-ons (FA, AM Lead, Fin.)", "Offboarding (FA + AM Lead)"]),
    ("Catalogue", [("Services & Tiers", "FA"), ("Bundles", "FA"), ("Add-ons", "FA"), ("Discount Limits", "FA"), "Proposal & Agreement Templates"]),
    ("Operations", ["SOP Library", "Requirement Checklists", "Department Flow Templates", "QC Checklists", "Gate Rules", "SLA Rules", "Error Log"]),
    ("Finance", [("Invoices", "$"), ("Invoice Plans", "$"), ("Billing Run", "$"), ("Payments", "$"), ("Payments to Match", "$"), ("Expenses & Bills", "$"),
                 ("Credit Notes", "$"), ("Creator Payouts", "$"), "Profit (FA, Finance, AM Lead)", ("Cash Flow", "$"), ("GST Settings", "$"), ("Accounting Sync", "$")]),
    ("Platform", [("System Health", "FA"), ("AI Copilot", "FA"), "Notification Templates", ("Outbox", "FA"), ("Integrations", "FA"), ("API & Webhooks", "FA"),
                  "Branding & Theme", ("Security", "FA"), ("Audit Log", "FA"), ("Privacy (DPDP)", "FA"), ("Data Export / Deletion", "FA"), ("Tenant Settings", "FA")]),
]


def cc_page(title, sections, ncols):
    header("Command Centre  /admin", title)
    c.setFillColor(INK)
    c.setFont("Helvetica", 8)
    c.drawString(M, H - 74, "Open to: Founder, Admin, Department Head, Finance, HR / Ops, AM Lead. Everyone else is sent to the Team app.")
    legend(M, H - 88, ["FA", "$", "P", "L", "N"])
    columns(sections, H - 100, ncols)
    c.showPage()


cc_page("13 sections, about 90 pages", cc + cc2, 4)

# =========================================================== PAGE 5: Team app
header("Team app  /team", "Every staff member; items appear by role")
team = [
    ("Work", ["My Day / My workspace", "Manager workspace (craft managers)", "Dashboards", "Leads (sales roles)", "Proposals (sales roles)",
              "Discount approvals (Sales Mgr, Admin, Founder)", "Renewals (all-leads scope)", "Client 360 (client team)", "Tasks", "QC queue (QC roles)",
              "Review Studio", "Projects", "Requests inbox (client team)", "Messages (client team)", "Inbox (AM & sales roles)", "Meetings", "Goals",
              "Documents", "Creators (AM, Dept Head, Admin)", "Files", "Asset library", "Brand kits", "Discussions"]),
    None,
    ("Plan", ["Calendar", "Content calendar", "Capacity", "Workload", "Specialists (leaders)", "SOP library"]),
    ("You", ["My performance", "My timesheet", "My expenses", "Approvals", "Agent Inbox", "My onboarding", "Profile, leave & attendance"]),
    None,
    ("Admin (admin roles only)", ["Command Centre", "Dashboard Studio (Founder, Admin)"]),
]
columns(team, H - 76, 3, row=12.4)
c.setFont("Helvetica", 7.6)
c.setFillColor(MUTED)
c.drawString(M, 34, "Client team = Founder, Admin, AM Lead, Account Manager, Finance.   Craft specialists (design, video, dev...) get a personal workspace as their home page.")
c.showPage()

# =========================================================== PAGE 6: client, creator, public
header("Client portal, Creator portal and Public website", "Outside users")
outside = [
    ("Client portal  /client - Your account", ["Home", "Project journey", "Onboarding", "Approvals", "Review Studio", "Content calendar", "Requests",
                                                "Files", "Asset library", "Brand kit", "Billing (Owner & Finance)", "Reports", "Insights", "Messages",
                                                "Meetings", "Documents"]),
    ("Client portal  /client - Settings", ["Account and services", "Team users", "Profile & notifications"]),
    None,
    ("Creator portal  /creator", ["Briefs", "Revisions", "Payouts", "Profile"]),
    ("Public website  / (no login)", ["Home", "Services", "Package builder", "Enquiry", "Book a call  /book/[name]", "Sign in", "Privacy"]),
    None,
    ("Links sent to clients (no login)", ["Proposal  /p/[link]", "Agreement  /p/[link]/agreement", "Pay invoice  /pay/[link]", "Proof review  /proof/[link]",
                                           "Shared item  /s/[link]"]),
    ("Account", ["Security (passkeys, 2-step)  /security"]),
]
columns(outside, H - 76, 3, row=12.4)
c.showPage()

c.save()
print("written", OUT)
