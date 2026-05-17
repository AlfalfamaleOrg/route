<?php
declare(strict_types=1);

/**
 * Route Optimizer - serves the SPA and proxies Google Maps list requests.
 *
 * GET /                 -> renders index.html
 * GET /?action=load&url=...
 *                       -> resolves a Google Maps list URL or ID and returns
 *                          a JSON payload { title, items: [{name, lat, lng}, ...] }
 */

if (($_GET['action'] ?? null) === 'load') {
    header('Content-Type: application/json; charset=utf-8');
    try {
        $input = trim((string) ($_GET['url'] ?? ''));
        if ($input === '') {
            throw new RuntimeException('Geen URL of lijst-ID opgegeven.');
        }
        $listId = resolve_list_id($input);
        $payload = fetch_list($listId);
        echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    } catch (Throwable $e) {
        http_response_code(400);
        echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
    }
    exit;
}

readfile(__DIR__ . '/index.html');

/**
 * Resolves user input to a Google Maps list ID.
 *
 * Accepts short links (maps.app.goo.gl/xxx), long links containing the list
 * marker in /data= or /placelists/list/<id>, or a raw ID.
 *
 * @param string $input
 * @return string
 */
function resolve_list_id(string $input): string
{
    if (preg_match('#^[A-Za-z0-9_-]{20,}$#', $input)) {
        return $input;
    }
    if (!preg_match('#^https?://#i', $input)) {
        throw new RuntimeException('Plak een Google Maps lijst-URL of een lijst-ID.');
    }
    $finalUrl = follow_redirects($input);
    if (preg_match('#/placelists/list/([A-Za-z0-9_-]+)#', $finalUrl, $m)) {
        return $m[1];
    }
    if (preg_match('#!2s([A-Za-z0-9_-]+)!3e3#', $finalUrl, $m)) {
        return $m[1];
    }
    if (preg_match('#!2s([A-Za-z0-9_-]+)#', $finalUrl, $m)) {
        return $m[1];
    }
    throw new RuntimeException('Kon geen lijst-ID vinden in deze URL.');
}

/**
 * Follows redirects without downloading the body.
 *
 * @param string $url
 * @return string
 */
function follow_redirects(string $url): string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_NOBODY => false,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        CURLOPT_TIMEOUT => 15,
        CURLOPT_ACCEPT_ENCODING => '',
    ]);
    $body = curl_exec($ch);
    if ($body === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('Kon URL niet ophalen: ' . $err);
    }
    $finalUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);
    if (preg_match('#/placelists/list/([A-Za-z0-9_-]+)#', (string) $body, $m)) {
        return 'https://www.google.com/maps/placelists/list/' . $m[1];
    }
    return $finalUrl;
}

/**
 * Calls the entitylist/getlist endpoint and extracts items.
 *
 * @param string $listId
 * @return array{title:string,items:array<int,array{name:string,lat:float,lng:float,address:?string}>}
 */
function fetch_list(string $listId): array
{
    $pb = '!1m4!1s' . $listId . '!2e1!3m1!1e1!2e2!3e2!4i500';
    $url = 'https://www.google.com/maps/preview/entitylist/getlist'
        . '?authuser=0&hl=nl&gl=nl&pb=' . rawurlencode($pb);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        CURLOPT_TIMEOUT => 20,
        CURLOPT_ACCEPT_ENCODING => '',
    ]);
    $raw = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('Google call mislukt: ' . $err);
    }
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200) {
        throw new RuntimeException('Google gaf status ' . $code . ' terug.');
    }
    $raw = (string) $raw;
    if (str_starts_with($raw, ")]}'")) {
        $raw = substr($raw, strpos($raw, "\n") + 1);
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new RuntimeException('Onverwacht antwoord van Google.');
    }
    $title = (string) ($data[0][4] ?? '');
    $rawItems = $data[0][8] ?? [];
    if (!is_array($rawItems)) {
        throw new RuntimeException('Lijst is leeg of niet leesbaar.');
    }
    $items = [];
    foreach ($rawItems as $it) {
        $coordsBlk = $it[1][5] ?? null;
        $name = (string) ($it[2] ?? '');
        if (!is_array($coordsBlk) || count($coordsBlk) < 4) {
            continue;
        }
        $lat = $coordsBlk[2] ?? null;
        $lng = $coordsBlk[3] ?? null;
        if (!is_numeric($lat) || !is_numeric($lng)) {
            continue;
        }
        $address = null;
        if (is_string($it[1][4] ?? null) && $it[1][4] !== '') {
            $address = $it[1][4];
        }
        $items[] = [
            'name' => $name !== '' ? $name : 'Onbekend',
            'lat' => (float) $lat,
            'lng' => (float) $lng,
            'address' => $address,
        ];
    }
    if (!$items) {
        throw new RuntimeException('Geen plekken met coördinaten gevonden in de lijst.');
    }
    return ['title' => $title, 'items' => $items];
}
