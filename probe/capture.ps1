# 开发期屏幕捕获量测：抓「挂件实际渲染到屏幕上的样子」
#
# 为什么需要它：Rust 侧只能证明「窗口几何精确」，前端只能证明「画布 transform 写对了」，
# 但用户看到的是 DWM 合成 + WebView2 合成两条路径叠加后的画面。本脚本直接读屏幕像素，
# 用探针画的两个标记（品红底 + 黑色锚点方块）逐帧量出：
#   · 品红块边界 = 挂件内容实际渲染到屏幕上的矩形（与窗口几何是否一致）
#   · 黑块质心   = 滚轮锚点的真实屏幕位置（理想：整个手势纹丝不动）
#
# 质心用两遍法：
#   ① 硬阈值（三通道 <60）在品红块内定位黑块 —— 天然排除右上角 ↩ 按钮的深色描边
#      （按钮描边是半透明深蓝叠品红，r 通道被抬到 ~165，过不了阈值）；
#   ② 在①结果 ±25px 窗口内做**亮度加权质心**（亚像素）—— 硬阈值质心只有 0.5px 量化，
#      会把「残余抖动」和「量测噪声」混在一起，无法判断是否已到噪声底。
#
# 用法：pwsh -File probe/capture.ps1 -Out probe/traces/cap.csv [-DurationMs 4000]

param(
  [int]$X = 150,
  [int]$Y = 380,
  [int]$W = 1000,
  [int]$H = 760,
  [int]$DurationMs = 4000,
  [int]$Win = 25,
  [string]$Out = "probe/traces/cap.csv"
)

$ErrorActionPreference = "Stop"

$cs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;

public class AqmCap
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    public static bool MakeDpiAware()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
        try { if (SetProcessDPIAware()) return true; } catch { }
        return false;
    }

    // CSV: t_ms, 品红bbox, 硬阈值质心(hx,hy,hn), 加权质心(kx,ky)
    public static string Run(int x, int y, int w, int h, int durationMs, int win)
    {
        bool aware = MakeDpiAware();
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        var g = Graphics.FromImage(bmp);
        var buf = new int[w * h];
        var sb = new StringBuilder();
        sb.Append("# dpiAware=").Append(aware ? "1" : "0")
          .Append(" region=").Append(x).Append(',').Append(y).Append(' ').Append(w).Append('x').Append(h)
          .Append(" win=").Append(win).Append('\n');
        sb.Append("t_ms,mx0,my0,mx1,my1,mw,mh,hx,hy,hn,kx,ky\n");
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < durationMs)
        {
            long t = sw.ElapsedMilliseconds;
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(data.Scan0, buf, 0, buf.Length);
            bmp.UnlockBits(data);

            int mx0 = int.MaxValue, my0 = int.MaxValue, mx1 = -1, my1 = -1;
            for (int yy = 0; yy < h; yy++)
            {
                int row = yy * w;
                for (int xx = 0; xx < w; xx++)
                {
                    int p = buf[row + xx];
                    int b = p & 0xFF, gg = (p >> 8) & 0xFF, r = (p >> 16) & 0xFF;
                    if (r > 190 && gg < 90 && b > 190)   // 品红 #FF00FF
                    {
                        if (xx < mx0) mx0 = xx;
                        if (yy < my0) my0 = yy;
                        if (xx > mx1) mx1 = xx;
                        if (yy > my1) my1 = yy;
                    }
                }
            }

            // ① 硬阈值质心（只在品红 bbox 内，排除桌面黑像素）
            double hx = 0, hy = 0;
            long kn = 0, hxS = 0, hyS = 0;
            if (mx1 > mx0)
            {
                for (int yy = my0; yy <= my1; yy++)
                {
                    int row = yy * w;
                    for (int xx = mx0; xx <= mx1; xx++)
                    {
                        int p = buf[row + xx];
                        int b = p & 0xFF, gg = (p >> 8) & 0xFF, r = (p >> 16) & 0xFF;
                        if (r < 60 && gg < 60 && b < 60) { hxS += xx; hyS += yy; kn++; }
                    }
                }
                if (kn > 0) { hx = (double)hxS / kn; hy = (double)hyS / kn; }
            }

            // ② 加权亚像素质心（限制在①的 ±win 窗口，避开 ↩ 按钮描边等其它深色像素）
            double kx = 0, ky = 0;
            if (kn > 0)
            {
                int wx0 = Math.Max(mx0, (int)hx - win), wx1 = Math.Min(mx1, (int)hx + win);
                int wy0 = Math.Max(my0, (int)hy - win), wy1 = Math.Min(my1, (int)hy + win);
                double wsum = 0, kxS = 0, kyS = 0;
                for (int yy = wy0; yy <= wy1; yy++)
                {
                    int row = yy * w;
                    for (int xx = wx0; xx <= wx1; xx++)
                    {
                        int p = buf[row + xx];
                        int b = p & 0xFF, gg = (p >> 8) & 0xFF, r = (p >> 16) & 0xFF;
                        int mxv = r > gg ? (r > b ? r : b) : (gg > b ? gg : b);
                        if (mxv >= 200) continue;        // 品红/亮背景不计权
                        double wt = 255.0 - mxv;         // 越黑权重越大
                        kxS += xx * wt; kyS += yy * wt; wsum += wt;
                    }
                }
                if (wsum > 0) { kx = kxS / wsum; ky = kyS / wsum; }
            }

            sb.Append(t).Append(',')
              .Append(mx0 == int.MaxValue ? 0 : mx0).Append(',').Append(my0 == int.MaxValue ? 0 : my0).Append(',')
              .Append(mx1).Append(',').Append(my1).Append(',')
              .Append(mx1 > mx0 ? mx1 - mx0 + 1 : 0).Append(',').Append(my1 > my0 ? my1 - my0 + 1 : 0).Append(',')
              .Append(hx.ToString("F2")).Append(',').Append(hy.ToString("F2")).Append(',').Append(kn).Append(',')
              .Append(kx.ToString("F3")).Append(',').Append(ky.ToString("F3")).Append('\n');
        }
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing -ErrorAction Stop

$csv = [AqmCap]::Run($X, $Y, $W, $H, $DurationMs, $Win)

$outPath = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }
$dir = Split-Path $outPath -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[IO.File]::WriteAllText($outPath, $csv, (New-Object Text.UTF8Encoding($false)))

$lines = $csv -split "`n" | Where-Object { $_ -and -not $_.StartsWith('#') -and -not $_.StartsWith('t_ms') }
Write-Output "捕获完成：$($lines.Count) 帧 -> $outPath"
Write-Output ($csv -split "`n")[0]
