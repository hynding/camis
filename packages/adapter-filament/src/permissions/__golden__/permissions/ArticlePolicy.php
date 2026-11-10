<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\AdminUser;
use App\Models\Article;
use App\Models\User;
use App\Support\Ring1;

class ArticlePolicy
{
    public function create(User|AdminUser $user): bool
    {
        return false;
    }

    public function deleteAny(User|AdminUser $user): bool
    {
        return false;
    }

    public function delete(User|AdminUser $user, Article $record): bool
    {
        return false;
    }

    public function viewAny(User|AdminUser $user): bool
    {
        return $user->can('article.read');
    }

    public function view(User|AdminUser $user, Article $record): bool
    {
        if (! $user->can('article.read')) {
            return false;
        }
        $data = [
            'user.id' => $user->id,
            'user.email' => $user->email,
            'user.role' => $user->getRoleNames()->first(),
            'record.title' => $record->title,
            'record.status' => $record->status,
        ];
        $result = Ring1::eq(fn() => Ring1::var($data, "record.status"), fn() => Ring1::lit("published"));
        return $result['ok'] === true && $result['value'] === true;
    }

    public function update(User|AdminUser $user, Article $record): bool
    {
        if (! $user->can('article.update')) {
            return false;
        }
        $data = [
            'user.id' => $user->id,
            'user.email' => $user->email,
            'user.role' => $user->getRoleNames()->first(),
            'record.title' => $record->title,
            'record.status' => $record->status,
        ];
        $result = Ring1::eq(fn() => Ring1::var($data, "record.status"), fn() => Ring1::lit("published"));
        return $result['ok'] === true && $result['value'] === true;
    }
}
