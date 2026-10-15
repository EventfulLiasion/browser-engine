using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Titan.Desktop;

public sealed class BrowserWindow : Form
{
    private const string HomeUrl = "https://www.youtube.com/";
    private readonly string profileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TitanBrowser");
    private readonly TabControl tabs = new() { Dock = DockStyle.Fill, HotTrack = true, Padding = new Point(14, 5), DrawMode = TabDrawMode.OwnerDrawFixed, ItemSize = new Size(190, 32), SizeMode = TabSizeMode.Fixed };
    private readonly TextBox address = new() { Width = 700, Font = new Font("Segoe UI", 10), BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(8, 4, 8, 4) };
    private readonly FlowLayoutPanel toolbar = new() { Dock = DockStyle.Top, Height = 46, Padding = new Padding(8, 5, 8, 4), WrapContents = false, BackColor = Color.FromArgb(245, 246, 248) };
    private readonly FlowLayoutPanel bookmarkBar = new() { Dock = DockStyle.Top, Height = 34, Padding = new Padding(10, 2, 2, 2), WrapContents = false, BackColor = Color.White };
    private readonly StatusStrip status = new() { SizingGrip = false, BackColor = Color.FromArgb(248, 249, 250) };
    private readonly ToolStripStatusLabel statusText = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft, Text = "Ready" };
    private readonly ToolStripProgressBar progress = new() { Visible = false, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25, Width = 110 };
    private readonly List<Bookmark> bookmarks = [];
    private readonly List<HistoryItem> history = [];
    private readonly List<DownloadItem> downloads = [];
    private readonly Stack<string> closedTabs = new();
    private CoreWebView2Environment? webEnvironment;
    private bool addressEdit;
    private bool inFullscreen;
    private FormBorderStyle borderBeforeFullscreen;
    private FormWindowState windowBeforeFullscreen;
    private Form? downloadsWindow;
    private ListBox? downloadsList;

    private WebView2? Current => tabs.SelectedTab?.Controls.OfType<WebView2>().FirstOrDefault();

    public BrowserWindow()
    {
        Text = "Titan";
        MinimumSize = new Size(760, 520);
        Size = new Size(1360, 900);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;
        BackColor = Color.White;
        Font = new Font("Segoe UI", 9);

        toolbar.Controls.AddRange([
            Button("‹", "Back", (_, _) => Current?.GoBack()),
            Button("›", "Forward", (_, _) => Current?.GoForward()),
            Button("⟳", "Reload", (_, _) => Current?.Reload()),
            Button("⌂", "Home", (_, _) => Navigate(HomeUrl)),
            Button("+", "New tab (Ctrl+T)", async (_, _) => await AddTabAsync()),
            address,
            Button("☆", "Bookmark this page (Ctrl+D)", (_, _) => ToggleBookmark()),
            Button("⋮", "Browser menu", (_, _) => ShowBrowserMenu())
        ]);
        tabs.MouseDown += TabsMouseDown;
        tabs.DrawItem += DrawTab;
        tabs.SizeChanged += (_, _) => UpdateTabWidths();
        tabs.SelectedIndexChanged += (_, _) => SyncActiveTab();
        address.Enter += (_, _) => { addressEdit = true; address.SelectAll(); };
        address.Leave += (_, _) => addressEdit = false;
        address.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; addressEdit = false; Navigate(address.Text); ActiveControl = Current; }
            if (e.KeyCode == Keys.Escape) { SyncAddress(); ActiveControl = Current; }
        };
        toolbar.Resize += (_, _) => address.Width = Math.Max(170, toolbar.ClientSize.Width - 480);
        status.Items.Add(statusText);
        status.Items.Add(progress);
        Controls.Add(tabs);
        Controls.Add(status);
        Controls.Add(bookmarkBar);
        Controls.Add(toolbar);
        LoadSavedData();
        Shown += async (_, _) =>
        {
            Program.Log("Window shown; reading saved session");
            try
            {
                var savedTabs = LoadSavedTabs().Where(s => Uri.IsWellFormedUriString(s, UriKind.Absolute)).Take(8).ToList();
                Program.Log($"Session contains {savedTabs.Count} restorable tabs");
                if (savedTabs.Count == 0) await AddTabAsync(HomeUrl);
                else
                {
                    await AddTabAsync(savedTabs[0]);
                    if (savedTabs.Count > 1) _ = RestoreRemainingTabsAsync(savedTabs.Skip(1).ToList());
                }
                RenderBookmarks();
            }
            catch (Exception ex)
            {
                LogStartupError(ex);
                ShowStartupError(ex);
            }
        };
        KeyDown += BrowserKeyDown;
        FormClosed += (_, _) => SaveData();
    }

    private static Button Button(string label, string tooltip, EventHandler click)
    {
        var button = new Button
        {
            Text = label, AutoSize = true, Height = 31, MinimumSize = new Size(34, 30),
            Margin = new Padding(2), FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(245, 246, 248), ForeColor = Color.FromArgb(40, 45, 52),
            Font = new Font("Segoe UI", 11)
        };
        button.FlatAppearance.BorderSize = 0;
        button.Click += click;
        new ToolTip().SetToolTip(button, tooltip);
        return button;
    }

    private async Task<WebView2> AddTabAsync(string? target = null, bool makeActive = true)
    {
        var page = new TabPage("New tab") { BackColor = Color.White, ToolTipText = "New tab" };
        var view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
        var loading = new Label { Dock = DockStyle.Fill, BackColor = Color.White, ForeColor = Color.FromArgb(80, 90, 105), Text = "Starting Titan's Chromium engine…", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12) };
        page.Controls.Add(view);
        page.Controls.Add(loading);
        tabs.TabPages.Add(page);
        UpdateTabWidths();
        if (makeActive) tabs.SelectedTab = page;
        try
        {
            Program.Log($"Initializing tab: {target ?? "start page"}");
            if (makeActive) statusText.Text = "Starting Chromium…";
            Directory.CreateDirectory(profileDir);
            webEnvironment ??= await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(profileDir, "WebView2"))
                .WaitAsync(TimeSpan.FromSeconds(20));
            Program.Log("WebView2 environment created");
            await view.EnsureCoreWebView2Async(webEnvironment).WaitAsync(TimeSpan.FromSeconds(25));
            Program.Log("WebView2 control initialized");
            ConfigureCore(view, page);
            page.Controls.Remove(loading);
            loading.Dispose();
            if (target is null) ShowStartPage(view);
            else view.CoreWebView2.Navigate(NormalizeAddress(target));
            Program.Log("Navigation started");
            if (makeActive) SyncActiveTab();
            return view;
        }
        catch (Exception ex)
        {
            Program.Log("Tab initialization failed: " + ex);
            LogStartupError(ex);
            loading.Dispose();
            if (tabs.TabPages.Contains(page)) tabs.TabPages.Remove(page);
            view.Dispose();
            page.Dispose();
            throw;
        }
    }

    private async Task RestoreRemainingTabsAsync(List<string> savedTabs)
    {
        foreach (var url in savedTabs)
        {
            try { await AddTabAsync(url, makeActive: false); }
            catch (Exception ex) { LogStartupError(ex); statusText.Text = "Some saved tabs couldn't be restored"; break; }
        }
    }

    private void ShowStartupError(Exception ex)
    {
        if (tabs.TabCount == 0)
        {
            var page = new TabPage("Browser error");
            var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(36), BackColor = Color.White };
            panel.Controls.Add(new Label { Text = "Titan couldn't start the Chromium engine.", Font = new Font("Segoe UI", 18, FontStyle.Bold), AutoSize = true, Location = new Point(36, 40) });
            panel.Controls.Add(new Label { Text = ex.Message + "\r\n\r\nCheck that Microsoft Edge WebView2 Runtime is installed. Details are in %LOCALAPPDATA%\\TitanBrowser\\startup-error.txt.", Font = new Font("Segoe UI", 10), AutoSize = true, MaximumSize = new Size(850, 120), Location = new Point(36, 95) });
            var retry = Button("Retry", "Try starting the page again", async (_, _) =>
            {
                tabs.TabPages.Remove(page);
                page.Dispose();
                await AddTabAsync(HomeUrl);
            });
            retry.Location = new Point(36, 220);
            panel.Controls.Add(retry);
            page.Controls.Add(panel);
            tabs.TabPages.Add(page);
        }
        statusText.Text = "Chromium startup failed — see startup-error.txt";
    }

    private void ConfigureCore(WebView2 view, TabPage page)
    {
        var core = view.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.DocumentTitleChanged += (_, _) =>
        {
            var title = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "New tab" : core.DocumentTitle;
            page.Text = Truncate(title, 20);
            page.ToolTipText = title;
            if (Current == view) Text = $"{title} — Titan";
        };
        core.SourceChanged += (_, _) => { if (Current == view) SyncAddress(); };
        core.NavigationStarting += (_, e) =>
        {
            if (Current == view) { progress.Visible = true; statusText.Text = "Loading " + e.Uri; SyncAddress(); }
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (Current == view)
            {
                progress.Visible = false;
                statusText.Text = e.IsSuccess ? "Done" : $"Could not load page ({e.WebErrorStatus})";
                SyncAddress();
            }
            if (e.IsSuccess && Uri.TryCreate(core.Source, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
                AddHistory(core.Source, core.DocumentTitle);
        };
        core.NewWindowRequested += async (_, e) =>
        {
            var deferral = e.GetDeferral();
            try
            {
                var popup = await AddTabAsync(null);
                e.NewWindow = popup.CoreWebView2;
            }
            catch (Exception ex) { statusText.Text = "Couldn't open new tab: " + ex.Message; }
            finally { deferral.Complete(); }
        };
        core.DownloadStarting += (_, e) =>
        {
            e.Handled = false;
            var operation = e.DownloadOperation;
            var entry = new DownloadItem(Path.GetFileName(e.ResultFilePath), e.ResultFilePath, "Downloading", DateTime.Now);
            downloads.Insert(0, entry);
            SaveData();
            statusText.Text = entry.Status + ": " + entry.Name;
            operation.StateChanged += (_, _) =>
            {
                var state = operation.State switch
                {
                    CoreWebView2DownloadState.Completed => "Complete",
                    CoreWebView2DownloadState.Interrupted => "Interrupted",
                    CoreWebView2DownloadState.InProgress => "Downloading",
                    _ => "Starting"
                };
                var index = downloads.FindIndex(item => item.Path == entry.Path);
                if (index >= 0) downloads[index] = entry with { Status = state };
                if (!IsDisposed && IsHandleCreated) BeginInvoke(() =>
                {
                    statusText.Text = state + ": " + entry.Name;
                    RefreshDownloadList();
                    SaveData();
                });
            };
        };
        core.ContainsFullScreenElementChanged += (_, _) =>
        {
            if (core.ContainsFullScreenElement && !inFullscreen)
            {
                inFullscreen = true;
                borderBeforeFullscreen = FormBorderStyle;
                windowBeforeFullscreen = WindowState;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
            }
            else if (!core.ContainsFullScreenElement && inFullscreen)
            {
                WindowState = windowBeforeFullscreen;
                FormBorderStyle = borderBeforeFullscreen;
                inFullscreen = false;
            }
        };
    }

    private static void ShowStartPage(WebView2 view)
    {
        view.CoreWebView2.NavigateToString("""
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>New Tab</title>
            <style>*{box-sizing:border-box}body{margin:0;background:#f8f9fb;color:#202124;font:16px 'Segoe UI',Arial;display:grid;place-items:center;min-height:100vh}.wrap{width:min(680px,90vw);text-align:center;margin-top:-7vh}.logo{font-size:62px;font-weight:650;letter-spacing:-4px;color:#384a68;margin-bottom:25px}.logo span{color:#6686c2}.search{display:flex;background:white;border:1px solid #dfe3e9;border-radius:28px;padding:8px 17px;box-shadow:0 3px 12px #24344b12}.search input{flex:1;border:0;outline:0;font-size:17px;padding:8px}.links{display:flex;justify-content:center;gap:18px;margin-top:35px;flex-wrap:wrap}a{color:#324361;text-decoration:none}.tile{width:112px;padding:16px 10px;border-radius:14px;background:transparent}.tile:hover{background:#edf0f5}.icon{font-size:27px;margin-bottom:8px}.sub{color:#7a8290;font-size:13px;margin-top:25px}</style></head><body><main class="wrap"><div class="logo">ti<span>tan</span></div>
            <form class="search" action="https://www.google.com/search"><input autofocus name="q" placeholder="Search Google or type a URL" aria-label="Search"></form>
            <nav class="links"><a class="tile" href="https://www.youtube.com/"><div class="icon">▶</div>YouTube</a><a class="tile" href="https://mail.google.com/"><div class="icon">✉</div>Gmail</a><a class="tile" href="https://drive.google.com/"><div class="icon">▣</div>Drive</a><a class="tile" href="https://news.google.com/"><div class="icon">▤</div>News</a></nav><div class="sub">Your browser, your tabs. Type a search or web address above.</div></main></body></html>
            """);
    }

    private async Task RestoreTabsAsync()
    {
        var saved = LoadSavedTabs();
        if (saved.Count == 0) { await AddTabAsync(HomeUrl); return; }
        foreach (var url in saved.Take(12)) await AddTabAsync(url, makeActive: false);
        if (tabs.TabPages.Count > 0) tabs.SelectedIndex = 0;
    }

    private void Navigate(string input)
    {
        var target = NormalizeAddress(input);
        if (Current is not { } view) { _ = AddTabAsync(target); return; }
        address.Text = target;
        addressEdit = false;
        try { view.CoreWebView2.Navigate(target); }
        catch { view.Source = new Uri(target); }
    }

    private static string NormalizeAddress(string input)
    {
        var value = input.Trim();
        if (string.IsNullOrWhiteSpace(value)) return HomeUrl;
        if (value.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return value;
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") return uri.ToString();
        if (!value.Contains(' ') && value.Contains('.')) return "https://" + value;
        return "https://www.google.com/search?q=" + Uri.EscapeDataString(value);
    }

    private void SyncAddress()
    {
        if (!addressEdit && Current?.Source is { } source) address.Text = source.ToString() == "about:blank" ? "" : source.ToString();
    }

    private void SyncActiveTab()
    {
        SyncAddress();
        if (Current is { } view && tabs.SelectedTab is { } page)
        {
            Text = $"{page.ToolTipText} — Titan";
            statusText.Text = "Ready";
        }
    }

    private void BrowserKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Control && e.Shift && e.KeyCode == Keys.T) { e.SuppressKeyPress = true; ReopenClosedTab(); }
        else if (e.Control && e.KeyCode == Keys.T) { e.SuppressKeyPress = true; _ = AddTabAsync(); }
        else if (e.Control && e.KeyCode == Keys.N) { e.SuppressKeyPress = true; Process.Start(Application.ExecutablePath); }
        else if (e.Control && e.KeyCode == Keys.W) { e.SuppressKeyPress = true; CloseCurrentTab(); }
        else if (e.Control && e.KeyCode == Keys.L) { e.SuppressKeyPress = true; address.Focus(); address.SelectAll(); }
        else if (e.Control && e.KeyCode == Keys.R || e.KeyCode == Keys.F5) { e.SuppressKeyPress = true; Current?.Reload(); }
        else if (e.Control && e.KeyCode == Keys.D) { e.SuppressKeyPress = true; ToggleBookmark(); }
        else if (e.Control && e.KeyCode == Keys.J) { e.SuppressKeyPress = true; ShowDownloads(); }
        else if (e.Control && e.KeyCode == Keys.H) { e.SuppressKeyPress = true; ShowHistory(); }
        else if (e.Control && e.KeyCode == Keys.F) { e.SuppressKeyPress = true; ShowFind(); }
        else if (e.KeyCode == Keys.F3) { e.SuppressKeyPress = true; FindNext(); }
        else if (e.Control && e.KeyCode == Keys.P) { e.SuppressKeyPress = true; Current?.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.Browser); }
        else if (e.Control && e.Shift && e.KeyCode == Keys.B) { e.SuppressKeyPress = true; bookmarkBar.Visible = !bookmarkBar.Visible; }
        else if (e.Alt && e.KeyCode == Keys.Left) { e.SuppressKeyPress = true; Current?.GoBack(); }
        else if (e.Alt && e.KeyCode == Keys.Right) { e.SuppressKeyPress = true; Current?.GoForward(); }
        else if (e.Control && e.KeyCode == Keys.Tab || e.Control && e.Shift && e.KeyCode == Keys.PageUp) { e.SuppressKeyPress = true; SelectRelativeTab(e.Shift ? -1 : 1); }
        else if (e.Control && e.KeyCode == Keys.PageDown) { e.SuppressKeyPress = true; SelectRelativeTab(1); }
        else if (e.Control && e.KeyCode >= Keys.D1 && e.KeyCode <= Keys.D8) { e.SuppressKeyPress = true; SelectTab(e.KeyCode - Keys.D1); }
        else if (e.Control && e.KeyCode == Keys.D9) { e.SuppressKeyPress = true; SelectTab(tabs.TabCount - 1); }
        else if (e.KeyCode == Keys.Escape && Current is { } view && view.CoreWebView2.ContainsFullScreenElement) view.CoreWebView2.ExecuteScriptAsync("document.exitFullscreen() ");
        else if (e.KeyCode == Keys.F12) { e.SuppressKeyPress = true; Current?.CoreWebView2.OpenDevToolsWindow(); }
        else if (e.Control && e.KeyCode == Keys.Add) { if (Current is { } v) v.ZoomFactor = Math.Min(3, v.ZoomFactor + .1); }
        else if (e.Control && e.KeyCode == Keys.Subtract) { if (Current is { } v) v.ZoomFactor = Math.Max(.3, v.ZoomFactor - .1); }
        else if (e.Control && e.KeyCode == Keys.D0) { if (Current is { } v) v.ZoomFactor = 1; }
    }

    private void DrawTab(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= tabs.TabPages.Count) return;
        var rect = tabs.GetTabRect(e.Index);
        var selected = e.Index == tabs.SelectedIndex;
        using var background = new SolidBrush(selected ? Color.White : Color.FromArgb(235, 238, 243));
        e.Graphics.FillRectangle(background, rect);
        var textRect = Rectangle.Inflate(rect, -12, -1);
        textRect.Width -= 22;
        TextRenderer.DrawText(e.Graphics, tabs.TabPages[e.Index].Text, Font, textRect, Color.FromArgb(40, 45, 52), TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.Left);
        TextRenderer.DrawText(e.Graphics, "×", Font, new Rectangle(rect.Right - 27, rect.Top + 4, 23, rect.Height - 8), Color.FromArgb(95, 102, 112), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }

    private void TabsMouseDown(object? sender, MouseEventArgs e)
    {
        for (var i = 0; i < tabs.TabCount; i++)
        {
            var rect = tabs.GetTabRect(i);
            if (!rect.Contains(e.Location)) continue;
            if (e.Button == MouseButtons.Middle) { CloseTab(i); return; }
            if (e.Button == MouseButtons.Left && e.X >= rect.Right - 30) { CloseTab(i); return; }
            if (e.Button == MouseButtons.Right)
            {
                tabs.SelectedIndex = i;
                var menu = new ContextMenuStrip();
                var tabIndex = i;
                menu.Items.Add("New tab", null, async (_, _) => await AddTabAsync());
                menu.Items.Add("Duplicate tab", null, async (_, _) => await AddTabAsync(tabs.TabPages[tabIndex].Controls.OfType<WebView2>().FirstOrDefault()?.Source?.ToString()));
                menu.Items.Add("Close tab", null, (_, _) => CloseTab(tabIndex));
                menu.Items.Add("Close other tabs", null, (_, _) => { for (var n = tabs.TabCount - 1; n >= 0; n--) if (n != tabIndex) CloseTab(n); });
                menu.Show(tabs, e.Location);
                return;
            }
        }
    }

    private void CloseCurrentTab() { if (tabs.SelectedIndex >= 0) CloseTab(tabs.SelectedIndex); }

    private void CloseTab(int index)
    {
        if (index < 0 || index >= tabs.TabPages.Count) return;
        var page = tabs.TabPages[index];
        var view = page.Controls.OfType<WebView2>().FirstOrDefault();
        if (view?.Source is { } source && source.Scheme is "http" or "https") closedTabs.Push(source.ToString());
        tabs.TabPages.RemoveAt(index);
        page.Dispose();
        UpdateTabWidths();
        if (tabs.TabCount == 0) _ = AddTabAsync();
    }

    private void ReopenClosedTab()
    {
        if (closedTabs.TryPop(out var url)) _ = AddTabAsync(url);
        else _ = AddTabAsync();
    }

    private void SelectRelativeTab(int offset)
    {
        if (tabs.TabCount < 2) return;
        tabs.SelectedIndex = (tabs.SelectedIndex + offset + tabs.TabCount) % tabs.TabCount;
    }

    private void SelectTab(int index)
    {
        if (tabs.TabCount > 0) tabs.SelectedIndex = Math.Clamp(index, 0, tabs.TabCount - 1);
    }

    private void UpdateTabWidths()
    {
        if (tabs.TabCount == 0) return;
        var width = Math.Clamp((tabs.ClientSize.Width - 36) / tabs.TabCount, 78, 190);
        if (tabs.ItemSize.Width != width || tabs.ItemSize.Height != 32) tabs.ItemSize = new Size(width, 32);
    }

    private void ToggleBookmark()
    {
        var view = Current;
        if (view?.Source is not { } source || !Uri.TryCreate(source.ToString(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return;
        var existing = bookmarks.FindIndex(b => b.Url == uri.ToString());
        if (existing >= 0) bookmarks.RemoveAt(existing);
        else bookmarks.Insert(0, new Bookmark(view.CoreWebView2.DocumentTitle, uri.ToString()));
        RenderBookmarks();
        SaveData();
        statusText.Text = existing >= 0 ? "Bookmark removed" : "Page bookmarked";
    }

    private void RenderBookmarks()
    {
        bookmarkBar.Controls.Clear();
        var label = new Label { Text = "Bookmarks", AutoSize = true, ForeColor = Color.FromArgb(105, 112, 124), Padding = new Padding(2, 6, 8, 0) };
        bookmarkBar.Controls.Add(label);
        foreach (var item in bookmarks.Take(12))
        {
            var button = Button("◆  " + Truncate(item.Title, 18), item.Url, (_, _) => Navigate(item.Url));
            button.Font = new Font("Segoe UI", 8.5f);
            button.Height = 27;
            button.Tag = item.Url;
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open in new tab", null, async (_, _) => await AddTabAsync(item.Url));
            menu.Items.Add("Remove bookmark", null, (_, _) => { bookmarks.Remove(item); RenderBookmarks(); SaveData(); });
            button.ContextMenuStrip = menu;
            bookmarkBar.Controls.Add(button);
        }
    }

    private void ShowBrowserMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("New tab\tCtrl+T", null, async (_, _) => await AddTabAsync());
        menu.Items.Add("New window", null, (_, _) => Process.Start(Application.ExecutablePath));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("History\tCtrl+H", null, (_, _) => ShowHistory());
        menu.Items.Add("Downloads\tCtrl+J", null, (_, _) => ShowDownloads());
        menu.Items.Add("Bookmarks", null, (_, _) => ToggleBookmark());
        menu.Items.Add("Show bookmarks bar\tCtrl+Shift+B", null, (_, _) => bookmarkBar.Visible = !bookmarkBar.Visible);
        menu.Items.Add("Reopen closed tab\tCtrl+Shift+T", null, (_, _) => ReopenClosedTab());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Zoom in", null, (_, _) => { if (Current is { } v) v.ZoomFactor = Math.Min(3, v.ZoomFactor + .1); });
        menu.Items.Add("Zoom out", null, (_, _) => { if (Current is { } v) v.ZoomFactor = Math.Max(.3, v.ZoomFactor - .1); });
        menu.Items.Add("Reset zoom", null, (_, _) => { if (Current is { } v) v.ZoomFactor = 1; });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Developer tools\tF12", null, (_, _) => Current?.CoreWebView2.OpenDevToolsWindow());
        menu.Items.Add("Find on page\tCtrl+F", null, (_, _) => ShowFind());
        menu.Items.Add("Print\tCtrl+P", null, (_, _) => Current?.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.Browser));
        menu.Items.Add("Open downloads folder", null, (_, _) => OpenDownloads());
        menu.Show(Cursor.Position);
    }

    private void OpenDownloads()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo("explorer.exe", folder) { UseShellExecute = true });
    }

    private void ShowDownloads()
    {
        if (downloadsWindow is { IsDisposed: false }) { RefreshDownloadList(); downloadsWindow.Activate(); return; }
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(10) };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        downloadsList = new ListBox { Dock = DockStyle.Fill, Font = new Font("Segoe UI", 10), IntegralHeight = false };
        downloadsList.DoubleClick += (_, _) => OpenSelectedDownload();
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        actions.Controls.Add(Button("Open downloads folder", "Show the downloads folder", (_, _) => OpenDownloads()));
        actions.Controls.Add(Button("Clear list", "Clear the recent downloads list", (_, _) => { downloads.Clear(); SaveData(); RefreshDownloadList(); }));
        layout.Controls.Add(downloadsList, 0, 0);
        layout.Controls.Add(actions, 0, 1);
        downloadsWindow = new Form { Text = "Downloads — Titan", StartPosition = FormStartPosition.CenterParent, Size = new Size(680, 480), MinimumSize = new Size(480, 300) };
        downloadsWindow.Controls.Add(layout);
        downloadsWindow.Show(this);
        RefreshDownloadList();
    }

    private void RefreshDownloadList()
    {
        if (downloadsList is null || downloadsList.IsDisposed) return;
        downloadsList.BeginUpdate();
        downloadsList.Items.Clear();
        foreach (var item in downloads.Take(200)) downloadsList.Items.Add(item);
        downloadsList.EndUpdate();
    }

    private void OpenSelectedDownload()
    {
        if (downloadsList?.SelectedItem is not DownloadItem item) return;
        if (!File.Exists(item.Path)) { statusText.Text = "That download file is no longer available"; return; }
        Process.Start(new ProcessStartInfo(item.Path) { UseShellExecute = true });
    }

    private Form? findWindow;
    private TextBox? findBox;

    private void ShowFind()
    {
        if (findWindow is { IsDisposed: false }) { findWindow.Activate(); findBox?.Focus(); return; }
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), WrapContents = false };
        findBox = new TextBox { Width = 250, Font = new Font("Segoe UI", 10), PlaceholderText = "Find on page" };
        panel.Controls.Add(findBox);
        panel.Controls.Add(Button("↓", "Find next (F3)", (_, _) => FindNext()));
        panel.Controls.Add(Button("×", "Close find", (_, _) => findWindow?.Close()));
        findBox.TextChanged += (_, _) => FindNext();
        findBox.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; FindNext(); } if (e.KeyCode == Keys.Escape) findWindow?.Close(); };
        findWindow = new Form { Text = "Find", FormBorderStyle = FormBorderStyle.FixedToolWindow, StartPosition = FormStartPosition.Manual, Location = PointToScreen(new Point(Math.Max(0, ClientSize.Width - 430), 90)), Size = new Size(390, 60), ShowInTaskbar = false };
        findWindow.Controls.Add(panel);
        findWindow.Show(this);
        findBox.Focus();
    }

    private void FindNext()
    {
        if (string.IsNullOrWhiteSpace(findBox?.Text) || Current?.CoreWebView2 is not { } core) return;
        core.ExecuteScriptAsync($"window.find({JsonSerializer.Serialize(findBox.Text)}, false, false, true)");
    }

    private async void ShowHistory()
    {
        var rows = string.Join("", history.Take(150).Select(h => $"<li><a href=\"{System.Net.WebUtility.HtmlEncode(h.Url)}\">{System.Net.WebUtility.HtmlEncode(h.Title)}</a><small>{System.Net.WebUtility.HtmlEncode(h.Url)} · {h.Visited:MMM d, h:mm tt}</small></li>"));
        var html = $"<!doctype html><meta charset=utf-8><title>History</title><style>body{{font:16px 'Segoe UI';max-width:900px;margin:40px auto;color:#202124}}li{{padding:12px;border-bottom:1px solid #eee}}a{{color:#315a9b;text-decoration:none}}small{{display:block;color:#778;margin-top:5px}}</style><h1>History</h1><ul>{rows}</ul>";
        try
        {
            var view = await AddTabAsync("about:blank");
            view.CoreWebView2.NavigateToString(html);
        }
        catch (Exception ex) { statusText.Text = "Couldn't open history: " + ex.Message; }
    }

    private void AddHistory(string url, string title)
    {
        if (history.Count > 0 && history[0].Url == url) return;
        history.Insert(0, new HistoryItem(string.IsNullOrWhiteSpace(title) ? url : title, url, DateTime.Now));
        if (history.Count > 500) history.RemoveRange(500, history.Count - 500);
        SaveData();
    }

    private List<string> LoadSavedTabs()
    {
        try { return JsonSerializer.Deserialize<List<string>>(File.ReadAllText(Path.Combine(profileDir, "session.json"))) ?? []; }
        catch { return []; }
    }

    private void LoadSavedData()
    {
        try { bookmarks.AddRange(JsonSerializer.Deserialize<List<Bookmark>>(File.ReadAllText(Path.Combine(profileDir, "bookmarks.json"))) ?? []); } catch { }
        try { history.AddRange(JsonSerializer.Deserialize<List<HistoryItem>>(File.ReadAllText(Path.Combine(profileDir, "history.json"))) ?? []); } catch { }
        try { downloads.AddRange(JsonSerializer.Deserialize<List<DownloadItem>>(File.ReadAllText(Path.Combine(profileDir, "downloads.json"))) ?? []); } catch { }
    }

    private void SaveData()
    {
        try
        {
            Directory.CreateDirectory(profileDir);
            File.WriteAllText(Path.Combine(profileDir, "bookmarks.json"), JsonSerializer.Serialize(bookmarks));
            File.WriteAllText(Path.Combine(profileDir, "history.json"), JsonSerializer.Serialize(history.Take(500)));
            File.WriteAllText(Path.Combine(profileDir, "downloads.json"), JsonSerializer.Serialize(downloads.Take(200)));
            var session = tabs.TabPages.Cast<TabPage>().Select(p => p.Controls.OfType<WebView2>().FirstOrDefault()?.Source?.ToString()).Where(s => !string.IsNullOrWhiteSpace(s) && !s.StartsWith("about:")).ToList();
            File.WriteAllText(Path.Combine(profileDir, "session.json"), JsonSerializer.Serialize(session));
        }
        catch (IOException) { }
    }

    private void LogStartupError(Exception ex)
    {
        try
        {
            Directory.CreateDirectory(profileDir);
            File.AppendAllText(Path.Combine(profileDir, "startup-error.txt"), $"[{DateTime.Now:O}] {ex}\r\n\r\n");
        }
        catch (IOException) { }
    }

    private static string Truncate(string? value, int length)
    {
        if (string.IsNullOrWhiteSpace(value)) return "New tab";
        return value.Length <= length ? value : value[..(length - 1)] + "…";
    }

    private sealed record Bookmark(string Title, string Url);
    private sealed record HistoryItem(string Title, string Url, DateTime Visited);
    private sealed record DownloadItem(string Name, string Path, string Status, DateTime Started)
    {
        public override string ToString() => $"{Status,-13} {Name}    {Path}    {Started:g}";
    }
}
