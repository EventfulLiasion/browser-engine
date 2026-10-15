namespace Titan.Desktop;

static class Program
{
    [STAThread]
    static void Main()
    {
        try
        {
            ApplicationConfiguration.Initialize();
            Log("WinForms initialized");
            var window = new BrowserWindow();
            Log("Browser window constructed");
            Application.Run(window);
            Log("Browser window closed");
        }
        catch (Exception ex)
        {
            Log(ex.ToString());
            MessageBox.Show($"Titan could not start the Chromium browser:\n\n{ex.Message}", "Titan startup error",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static void Log(string message)
    {
        try { File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "titan-startup.log"), $"[{DateTime.Now:O}] {message}{Environment.NewLine}"); }
        catch { }
    }
}
