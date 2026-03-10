using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class NtProcess
{
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetPriorityClass(IntPtr h, uint priorityClass);

  [DllImport("ntdll.dll")]
  public static extern int NtSuspendProcess(IntPtr h);

  [DllImport("ntdll.dll")]
  public static extern int NtResumeProcess(IntPtr h);

  public static int Suspend(int pid)
  {
    IntPtr h = OpenProcess(0x1F0FFF, false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
    int status = NtSuspendProcess(h);
    CloseHandle(h);
    return status;
  }

  public static int Resume(int pid)
  {
    IntPtr h = OpenProcess(0x1F0FFF, false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
    int status = NtResumeProcess(h);
    CloseHandle(h);
    return status;
  }

  public static int Throttle(int pid)
  {
    IntPtr h = OpenProcess(0x1F0FFF, false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
    bool ok = SetPriorityClass(h, 0x00000040); // IDLE_PRIORITY_CLASS
    CloseHandle(h);
    return ok ? 0 : Marshal.GetLastWin32Error();
  }

  public static int Restore(int pid)
  {
    IntPtr h = OpenProcess(0x1F0FFF, false, pid);
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
    bool ok = SetPriorityClass(h, 0x00000020); // NORMAL_PRIORITY_CLASS
    CloseHandle(h);
    return ok ? 0 : Marshal.GetLastWin32Error();
  }
}

public class Program
{
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);

  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  private const int SW_HIDE = 0;
  private const int SW_SHOW = 5;

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT
  {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  private static void PrintWindowList()
  {
    EnumWindows((hWnd, lParam) =>
    {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;
      GetWindowThreadProcessId(hWnd, out uint pid);
      string name = "Unknown";
      try
      {
        name = Process.GetProcessById((int)pid).ProcessName;
      }
      catch
      {
      }
      Console.WriteLine($"{pid}|||{name}|||{title}");
      return true;
    }, IntPtr.Zero);
  }

  private static void SetWindowVisibilityByPid(int pid, bool visible)
  {
    EnumWindows((hWnd, lParam) =>
    {
      GetWindowThreadProcessId(hWnd, out uint windowPid);
      if (windowPid != pid) return true;

      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;

      ShowWindow(hWnd, visible ? SW_SHOW : SW_HIDE);
      return true;
    }, IntPtr.Zero);
  }

  private static void SetWindowVisibilityByTitle(string targetTitle, bool visible)
  {
    if (string.IsNullOrWhiteSpace(targetTitle)) return;
    string needle = targetTitle.Trim();

    EnumWindows((hWnd, lParam) =>
    {
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;

      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
      {
        ShowWindow(hWnd, visible ? SW_SHOW : SW_HIDE);
      }

      return true;
    }, IntPtr.Zero);
  }

  private static void SetWindowVisibilityByTitleAndProcess(string targetTitle, string processName, bool visible)
  {
    if (string.IsNullOrWhiteSpace(targetTitle) || string.IsNullOrWhiteSpace(processName)) return;
    string needle = targetTitle.Trim();
    string procNeedle = processName.Trim();

    EnumWindows((hWnd, lParam) =>
    {
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;

      GetWindowThreadProcessId(hWnd, out uint pid);
      string procName = string.Empty;
      try
      {
        procName = Process.GetProcessById((int)pid).ProcessName;
      }
      catch
      {
        return true;
      }

      if (!procName.Equals(procNeedle, StringComparison.OrdinalIgnoreCase)) return true;

      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
      {
        ShowWindow(hWnd, visible ? SW_SHOW : SW_HIDE);
      }

      return true;
    }, IntPtr.Zero);
  }

  private static bool IsMostlyBlack(Bitmap bmp)
  {
    int sampleX = 10;
    int sampleY = 10;
    int width = bmp.Width;
    int height = bmp.Height;
    if (width <= 0 || height <= 0) return true;
    int stepX = Math.Max(1, width / sampleX);
    int stepY = Math.Max(1, height / sampleY);
    int total = 0;
    int dark = 0;
    for (int y = stepY / 2; y < height; y += stepY)
    {
      for (int x = stepX / 2; x < width; x += stepX)
      {
        Color c = bmp.GetPixel(x, y);
        int brightness = (c.R + c.G + c.B) / 3;
        if (brightness < 15) dark++;
        total++;
      }
    }
    if (total == 0) return true;
    return (dark * 100 / total) >= 90;
  }

  private static string CaptureWindowThumbnailBase64(IntPtr hWnd, int targetWidth, int targetHeight)
  {
    if (IsIconic(hWnd)) return string.Empty;
    if (!GetWindowRect(hWnd, out RECT rect)) return string.Empty;
    int width = rect.Right - rect.Left;
    int height = rect.Bottom - rect.Top;
    if (width <= 0 || height <= 0) return string.Empty;

    using (var bmp = new Bitmap(width, height))
    {
      using (var gfx = Graphics.FromImage(bmp))
      {
        IntPtr hdc = gfx.GetHdc();
        bool ok = PrintWindow(hWnd, hdc, 2);
        gfx.ReleaseHdc(hdc);
        if (!ok)
        {
          try
          {
            gfx.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
          }
          catch
          {
            return string.Empty;
          }
        }
      }

      using (var thumb = new Bitmap(targetWidth, targetHeight))
      using (var tgfx = Graphics.FromImage(thumb))
      {
        tgfx.InterpolationMode = InterpolationMode.Low;
        tgfx.SmoothingMode = SmoothingMode.None;
        tgfx.PixelOffsetMode = PixelOffsetMode.None;
        tgfx.DrawImage(bmp, 0, 0, targetWidth, targetHeight);

        if (IsMostlyBlack(thumb))
        {
          return string.Empty;
        }

        using (var ms = new MemoryStream())
        {
          thumb.Save(ms, ImageFormat.Png);
          return Convert.ToBase64String(ms.ToArray());
        }
      }
    }
  }

  private static void PrintWindowThumbnails(int targetWidth, int targetHeight)
  {
    int maxCount = 25;
    int count = 0;
    EnumWindows((hWnd, lParam) =>
    {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;

      GetWindowThreadProcessId(hWnd, out uint pid);
      string name = "Unknown";
      try
      {
        name = Process.GetProcessById((int)pid).ProcessName;
      }
      catch
      {
      }

      string base64 = CaptureWindowThumbnailBase64(hWnd, targetWidth, targetHeight);
      if (!string.IsNullOrWhiteSpace(base64))
      {
        Console.WriteLine($"{pid}|||{name}|||{title}|||{base64}");
        count++;
      }
      if (count >= maxCount) return false;
      return true;
    }, IntPtr.Zero);
  }

  public static int Main(string[] args)
  {
    if (args.Length == 0) return 2;
    string cmd = args[0].ToLowerInvariant();
    if (cmd == "windows")
    {
      PrintWindowList();
      return 0;
    }
    if (cmd == "thumbs")
    {
      int width = 240;
      int height = 150;
      if (args.Length >= 3)
      {
        int.TryParse(args[1], out width);
        int.TryParse(args[2], out height);
      }
      width = Math.Max(64, Math.Min(width, 640));
      height = Math.Max(48, Math.Min(height, 480));
      PrintWindowThumbnails(width, height);
      return 0;
    }
    if (cmd == "showtitle" || cmd == "hidetitle")
    {
      if (args.Length < 2) return 2;
      string title = string.Join(" ", args, 1, args.Length - 1);
      SetWindowVisibilityByTitle(title, cmd == "showtitle");
      return 0;
    }
    if (cmd == "showtitleproc" || cmd == "hidetitleproc")
    {
      if (args.Length < 3) return 2;
      string procName = args[1];
      string title = string.Join(" ", args, 2, args.Length - 2);
      SetWindowVisibilityByTitleAndProcess(title, procName, cmd == "showtitleproc");
      return 0;
    }

    if (args.Length < 2) return 2;
    if (!int.TryParse(args[1], out int pid)) return 3;
    if (cmd == "hide" || cmd == "show")
    {
      SetWindowVisibilityByPid(pid, cmd == "show");
      return 0;
    }
    int res = cmd switch
    {
      "resume" => NtProcess.Resume(pid),
      "throttle" => NtProcess.Throttle(pid),
      "restore" => NtProcess.Restore(pid),
      _ => NtProcess.Suspend(pid)
    };
    return res == 0 ? 0 : res;
  }
}
