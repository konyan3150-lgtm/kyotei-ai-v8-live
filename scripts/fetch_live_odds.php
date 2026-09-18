<?php
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use BVP\Scraper\Scraper;

date_default_timezone_set('Asia/Tokyo');
$now = new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo'));
$date = $now->format('Ymd');
$dateIso = $now->format('Y-m-d');
$programUrl = "https://boatraceopenapi.github.io/api/v1/{$now->format('Y')}/{$date}.json";
$raw = @file_get_contents($programUrl);
if ($raw === false) { fwrite(STDERR, "program unavailable\n"); exit(0); }
$program = json_decode($raw, true);
$stadiums = $program['programs']['stadiums'] ?? [];

$root = dirname(__DIR__);
$outputPath = $root . '/odds.json';
$existing = is_file($outputPath) ? json_decode((string) file_get_contents($outputPath), true) : null;
$payload = is_array($existing) && ($existing['date'] ?? '') === $date ? $existing : ['date'=>$date, 'updated_at'=>null, 'races'=>[]];
$candidates = [];
foreach ($stadiums as $stadiumNumber => $stadium) {
    foreach (($stadium['races'] ?? []) as $raceNumber => $race) {
        $rawClose = $race['closed_at'] ?? null;
        if (!$rawClose) continue;
        try { $close = new DateTimeImmutable(str_replace(' ', 'T', (string) $rawClose), new DateTimeZone('Asia/Tokyo')); } catch (Throwable) { continue; }
        $delta = $close->getTimestamp() - $now->getTimestamp();
        if ($delta >= -20 * 60 && $delta <= 75 * 60) $candidates[] = [(int)$stadiumNumber, (int)$raceNumber, $close->format(DATE_ATOM)];
    }
}
if (!$candidates) { echo "no races near cutoff\n"; exit(0); }

$scraper = new Scraper();
$success = 0; $failed = 0;
foreach ($candidates as [$stadiumNumber, $raceNumber, $closedAt]) {
    try {
        $result = $scraper->scrapeTrifecta($dateIso, $stadiumNumber, $raceNumber, true);
        $trifecta = $result['trifecta'] ?? [];
        if (!$trifecta) { $failed++; continue; }
        $payload['races'][(string)$stadiumNumber][(string)$raceNumber] = [
            'closed_at'=>$closedAt,
            'fetched_at'=>(new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo')))->format(DATE_ATOM),
            'trifecta'=>$trifecta,
        ];
        $success++;
    } catch (Throwable $e) {
        fwrite(STDERR, "{$stadiumNumber} {$raceNumber}R: {$e->getMessage()}\n"); $failed++;
    }
}
if (!$success) { echo "no odds updated; failed={$failed}\n"; exit(0); }
$payload['updated_at'] = (new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo')))->format(DATE_ATOM);
$payload['source'] = 'BOAT RACE official via bvp/scraper';
$payload['success'] = $success; $payload['failed'] = $failed;
$json = json_encode($payload, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
if ($json === false) throw new RuntimeException('JSON encode failed');
file_put_contents($outputPath, $json . "\n");
file_put_contents($root . '/dev/odds.json', $json . "\n");
echo "updated={$success} failed={$failed}\n";
