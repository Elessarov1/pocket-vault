param(
    [string]$OutputPath = (Join-Path $PSScriptRoot "..\web\assets\pocket-vault-bot-avatar.png")
)

Add-Type -AssemblyName System.Drawing

$size = 1024
$bitmap = [System.Drawing.Bitmap]::new(
    $size,
    $size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::GammaCorrected
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#1f2421"))

    $graphics.TranslateTransform(512, 512)
    $graphics.RotateTransform(-3)
    $graphics.TranslateTransform(-512, -512)

    $badgePath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    try {
        $badgePath.AddArc(202, 202, 400, 400, 180, 90)
        $badgePath.AddArc(422, 202, 400, 400, 270, 90)
        $badgePath.AddArc(422, 422, 400, 400, 0, 90)
        $badgePath.AddArc(202, 422, 400, 400, 90, 90)
        $badgePath.CloseFigure()
        $badgeBrush = [System.Drawing.SolidBrush]::new(
            [System.Drawing.ColorTranslator]::FromHtml("#caef77")
        )
        try {
            $graphics.FillPath($badgeBrush, $badgePath)
        }
        finally {
            $badgeBrush.Dispose()
        }
    }
    finally {
        $badgePath.Dispose()
    }

    $pen = [System.Drawing.Pen]::new(
        [System.Drawing.ColorTranslator]::FromHtml("#1b2414"),
        33
    )
    try {
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

        $vaultPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
        try {
            $vaultPath.StartFigure()
            $vaultPath.AddLine(352, 342, 672, 342)
            $vaultPath.AddLine(672, 342, 672, 626)
            $vaultPath.AddArc(500, 540, 172, 172, 0, 90)
            $vaultPath.AddLine(586, 712, 438, 712)
            $vaultPath.AddArc(352, 540, 172, 172, 90, 90)
            $vaultPath.AddLine(352, 626, 352, 342)
            $vaultPath.CloseFigure()
            $graphics.DrawPath($pen, $vaultPath)
        }
        finally {
            $vaultPath.Dispose()
        }

        $graphics.DrawLine($pen, 352, 442, 672, 442)
        $graphics.DrawLine($pen, 512, 442, 512, 526)
        $graphics.DrawEllipse($pen, 468, 522, 88, 88)
    }
    finally {
        $pen.Dispose()
    }

    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
    $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output $resolvedOutput
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
