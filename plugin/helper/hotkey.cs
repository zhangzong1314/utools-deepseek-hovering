// DeepSeek 悬浮助手 —— 全局热键小助手（源码，由 js/hotkey.js 编译后运行）
//
// 为什么要有这么个东西：uTools 没给插件"自己注册系统级热键"的 API，它自带的快捷键设置里
// Ctrl+Space 这类组合也设不上。所以插件自己带一份源码，第一次用到时用系统自带的 csc.exe
// 现编成 exe（见 js/hotkey.js），由它去调 Windows 原生的 RegisterHotKey。这样快捷键就在
// 插件里配，不依赖 uTools 的快捷键页。
//
// 用法：hotkey.exe <组合>       例如 hotkey.exe Ctrl+Space
// 和插件的协议（一行一条，只走 stdout）：
//   ready            起来了
//   ok <组合>        注册成功
//   fail <组合> ...  注册失败（多半是"这个组合被别的程序占着"，win32 1408）
//   hotkey           热键被按下
// 改绑不在这里做：插件把本进程杀掉、用新组合重新拉一个 —— 启动时（主线程）注册这条实测最稳，
// 而"从别的线程拿这个窗口句柄去 RegisterHotKey"会被系统当成已注册（1408），试过，不通。
// 父进程没了（stdin 关掉）就自己退，不留孤儿进程。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;
    private const int HOTKEY_ID = 0x4453;

    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint MOD_WIN = 0x0008;
    // 按住不放时别反复触发（我们按的是"一下开合"）
    private const uint MOD_NOREPEAT = 0x4000;

    private static readonly Dictionary<string, uint> KeyCodes = BuildKeyCodes();

    private static Dictionary<string, uint> BuildKeyCodes()
    {
        var map = new Dictionary<string, uint>(StringComparer.OrdinalIgnoreCase);
        for (var c = 'A'; c <= 'Z'; c++) map[c.ToString()] = (uint)c;
        for (var d = '0'; d <= '9'; d++) map[d.ToString()] = (uint)d;
        for (var i = 1; i <= 24; i++) map["F" + i] = (uint)(0x70 + i - 1);
        map["Space"] = 0x20;
        map["Tab"] = 0x09;
        map["Enter"] = 0x0D;
        map["Return"] = 0x0D;
        map["Esc"] = 0x1B;
        map["Escape"] = 0x1B;
        map["Backspace"] = 0x08;
        map["Delete"] = 0x2E;
        map["Del"] = 0x2E;
        map["Insert"] = 0x2D;
        map["Up"] = 0x26;
        map["Down"] = 0x28;
        map["Left"] = 0x25;
        map["Right"] = 0x27;
        map["Home"] = 0x24;
        map["End"] = 0x23;
        map["PageUp"] = 0x21;
        map["PageDown"] = 0x22;
        map["-"] = 0xBD;
        map["="] = 0xBB;
        map["["] = 0xDB;
        map["]"] = 0xDD;
        map["\\"] = 0xDC;
        map[";"] = 0xBA;
        map["'"] = 0xDE;
        map[","] = 0xBC;
        map["."] = 0xBE;
        map["/"] = 0xBF;
        map["`"] = 0xC0;
        return map;
    }

    /// <summary>只用来收热键消息的隐藏窗口（不显示任何界面）</summary>
    private sealed class MessageWindow : NativeWindow
    {
        public event Action Fired;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                var handler = Fired;
                if (handler != null) handler();
            }
            base.WndProc(ref m);
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        var window = new MessageWindow();
        window.CreateHandle(new CreateParams());
        window.Fired += delegate
        {
            Console.WriteLine("hotkey");
            Console.Out.Flush();
        };

        Console.WriteLine("ready");
        Console.Out.Flush();

        var spec = args.Length > 0 ? string.Join("+", args) : "";
        if (spec.Length > 0) Bind(window, spec);

        // 只看 stdin 关没关（父进程走了就退），不处理任何命令
        var reader = new Thread(delegate()
        {
            while (Console.ReadLine() != null) { }
            Environment.Exit(0);
        });
        reader.IsBackground = true;
        reader.Start();

        // 消息循环：RegisterHotKey 注册的热键靠它派发 WM_HOTKEY
        Application.Run();
    }

    private static void Bind(MessageWindow window, string spec)
    {
        uint mods, vk;
        string error;
        if (!TryParse(spec, out mods, out vk, out error))
        {
            Console.WriteLine("fail " + spec + " " + error);
            Console.Out.Flush();
            return;
        }

        if (RegisterHotKey(window.Handle, HOTKEY_ID, mods | MOD_NOREPEAT, vk))
        {
            Console.WriteLine("ok " + spec);
        }
        else
        {
            var code = Marshal.GetLastWin32Error();
            var hint = code == 1409 /* ERROR_HOTKEY_ALREADY_REGISTERED 的另一个码 */ ? "被占用" : "";
            Console.WriteLine("fail " + spec + " 注册被拒（win32 " + code + " " + hint + "）");
        }
        Console.Out.Flush();
    }

    private static bool TryParse(string spec, out uint mods, out uint vk, out string error)
    {
        mods = 0;
        vk = 0;
        error = "";

        // 只按 + 切：'-' 本身也可能是键名（Ctrl+-）
        var parts = spec.Split('+');
        if (parts.Length == 0)
        {
            error = "组合是空的";
            return false;
        }

        for (var i = 0; i < parts.Length - 1; i++)
        {
            var name = parts[i].Trim();
            if (name.Equals("Ctrl", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Control", StringComparison.OrdinalIgnoreCase))
            {
                mods |= MOD_CONTROL;
            }
            else if (name.Equals("Alt", StringComparison.OrdinalIgnoreCase))
            {
                mods |= MOD_ALT;
            }
            else if (name.Equals("Shift", StringComparison.OrdinalIgnoreCase))
            {
                mods |= MOD_SHIFT;
            }
            else if (name.Equals("Win", StringComparison.OrdinalIgnoreCase) ||
                     name.Equals("Super", StringComparison.OrdinalIgnoreCase) ||
                     name.Equals("Meta", StringComparison.OrdinalIgnoreCase))
            {
                mods |= MOD_WIN;
            }
            else
            {
                error = "认不出的修饰键 " + name;
                return false;
            }
        }

        var keyName = parts[parts.Length - 1].Trim();
        uint code;
        if (!KeyCodes.TryGetValue(keyName, out code))
        {
            error = "认不出的键 " + keyName;
            return false;
        }
        vk = code;
        return true;
    }
}
