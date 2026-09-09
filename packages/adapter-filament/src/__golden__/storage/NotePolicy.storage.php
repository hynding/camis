<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Note;
use App\Models\User;
use App\Support\Ring1;

class NotePolicy
{
    public function create(User $user): bool
    {
        return in_array($user->roleType(), ['authenticated'], true);
    }

    public function delete(User $user, Note $record): bool
    {
        if (! in_array($user->roleType(), ['authenticated'], true)) {
            return false;
        }
        $data = [
            'user.id' => $user->id,
            'user.email' => $user->email,
            'user.role' => $user->roleType(),
            'record.recordId' => $record->record_id,
            'record.text' => $record->text,
            'record.occurredAt' => $record->occurred_at,
            'record.ownerId' => $record->ownerId,
        ];
        $result = Ring1::eq(fn() => Ring1::var($data, "record.ownerId"), fn() => Ring1::var($data, "user.id"));
        return $result['ok'] === true && $result['value'] === true;
    }

    public function viewAny(User $user): bool
    {
        return in_array($user->roleType(), ['authenticated'], true);
    }

    public function view(User $user, Note $record): bool
    {
        if (! in_array($user->roleType(), ['authenticated'], true)) {
            return false;
        }
        $data = [
            'user.id' => $user->id,
            'user.email' => $user->email,
            'user.role' => $user->roleType(),
            'record.recordId' => $record->record_id,
            'record.text' => $record->text,
            'record.occurredAt' => $record->occurred_at,
            'record.ownerId' => $record->ownerId,
        ];
        $result = Ring1::eq(fn() => Ring1::var($data, "record.ownerId"), fn() => Ring1::var($data, "user.id"));
        return $result['ok'] === true && $result['value'] === true;
    }

    public function update(User $user, Note $record): bool
    {
        if (! in_array($user->roleType(), ['authenticated'], true)) {
            return false;
        }
        $data = [
            'user.id' => $user->id,
            'user.email' => $user->email,
            'user.role' => $user->roleType(),
            'record.recordId' => $record->record_id,
            'record.text' => $record->text,
            'record.occurredAt' => $record->occurred_at,
            'record.ownerId' => $record->ownerId,
        ];
        $result = Ring1::eq(fn() => Ring1::var($data, "record.ownerId"), fn() => Ring1::var($data, "user.id"));
        return $result['ok'] === true && $result['value'] === true;
    }
}
